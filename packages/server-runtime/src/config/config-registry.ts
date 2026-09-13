/**
 * ConfigRegistry — the config subsystem of the bedrock-core Runtime.
 *
 * Accessible as `core.config` once an addon declared `config: config(definition)` in `register()`.
 *
 * Config is three db collections with a form on top: `config-server` holds the world's document,
 * `config-dimension` one per dimension, `config-player` one per player. Each document is nested
 * exactly as the schema is and holds only overrides — the schema's defaults are db's `defaults`,
 * and its write-time `normalize` coerces every value and keeps what is at a default out of the
 * bytes. Persistence, migration and quarantine are db's; this file adds the schema, the dotted
 * accessor trees, and the rpc methods the config UI in another realm calls — three scopes, each
 * with `get`, `patch` and `set`, authorized against the acting player.
 *
 * Discovery is push, values are pull: each addon publishes its (small, static) schema to the
 * shared mirror; values live with the owning addon. Write semantics, local and remote: `patch`
 * deep-merges the provided keys; `set` replaces the whole scope — any schema key missing from the
 * payload reverts to its schema default.
 *
 * An addon declares its config in `register()`, and the `config(definition)` declaration delegates
 * here; the accessors it returns are these:
 * ```ts
 * const declared = core.register({
 *   manifest,
 *   config: config({
 *     server:    { pricing: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
 *     dimension: { miningBonus: { type: 'number', default: 1.0, min: 0, max: 5, label: 'Mining Bonus' } },
 *     player:    { allowGifts: { type: 'boolean', default: true, label: 'Allow Gifts' } },
 *   }),
 * });
 *
 * const config = declared.config;
 *
 * // Every scope is a dotted accessor tree mirroring the schema — every node, group or leaf, is an
 * // observable with get / set / subscribe (groups also patch). Entity scopes pick the entity with for().
 * config.server.pricing.taxRate.get()            // number — local, sync
 * config.server.pricing.taxRate.set(0.1)
 * config.server.pricing.taxRate.subscribe((next, prev) => { ... })
 * config.server.pricing.subscribe(pricing => { ... })
 * config.player.for(player).allowGifts.get()
 *
 * config.server.get()                            // { pricing: { taxRate: number } } — whole scope
 * config.server.patch({ pricing: { taxRate: 0.1 } })
 * config.dimension.for(dim).patch({ miningBonus: 2.0 })
 * ```
 *
 * Cross-addon access goes over those methods:
 * ```ts
 * const shopCfg = core.config.of<ShopConfigDef>('vendor_shop', { actorId: player.id });
 * await shopCfg?.server.get()                    // structured, typed, defaults filled
 * await shopCfg?.server.patch({ pricing: { taxRate: 0.1 } })
 * ```
 */
import { system, world } from '@minecraft/server';
import type { Dimension, Player, World } from '@minecraft/server';
import type { Rpc, SyncNode, Unsubscribe } from '@bedrock-core/sync';
import { dimensions, players, schema, worldTarget, type Db, type DeepPartial, type MigrateStep, type Schema } from '@bedrock-core/db';
import {
  type ConfigDefinition,
  type ConfigScopeName,
  type FlatSchema,
  type SchemaGroup,
  type SchemaToValue,
  type ServerScopeSchema,
  type DimensionScopeSchema,
  type PlayerScopeSchema,
  type FlatGroups,
  flattenGroups,
  flattenSchema,
  validateConfigSchema,
} from './schema';
import { EntityScope, serverScope, type Gate, type ScopeTree } from './scopes/scope';
import { defaultsOf, normalizeAgainst, type ConfigDocument } from './document';
import { Announcement, isRecord } from '../announcement';
import { authorize } from '../authorization';
import { isUsable } from '../handle';

/** The db collections a scope's documents live in, under the owning addon's namespace. */
export const CONFIG_COLLECTIONS: Record<ConfigScopeName, string> = {
  server: 'config-server',
  dimension: 'config-dimension',
  player: 'config-player',
};

/**
 * The rpc method one config scope answers on: `core:config.<scope>.<op>`. Under the framework's
 * own prefix, since the runtime registers these for every addon rather than the addon doing it.
 */
export function configMethod(scope: ConfigScopeName, operation: 'get' | 'patch' | 'set'): string {
  return `core:config.${scope}.${operation}`;
}

/** How a scope's target is named in the params of its methods. */
const TARGET_PARAM: Record<ConfigScopeName, string | undefined> = {
  server: undefined,
  dimension: 'dimId',
  player: 'playerId',
};

// ─── Return types ──────────────────────────────────────────────────────────────

type SafeServer<I extends ConfigDefinition>
  = NonNullable<I['server']> extends ServerScopeSchema ? NonNullable<I['server']> : Record<never, never>;
type SafeDimension<I extends ConfigDefinition>
  = NonNullable<I['dimension']> extends DimensionScopeSchema ? NonNullable<I['dimension']> : Record<never, never>;
type SafePlayer<I extends ConfigDefinition>
  = NonNullable<I['player']> extends PlayerScopeSchema ? NonNullable<I['player']> : Record<never, never>;

/**
 * This addon's own scopes, as returned by the `config(definition)` declaration.
 *
 * `server` is the scope *and* its accessor tree — `config.server.get()` alongside
 * `config.server.pricing.taxRate.get()`. The entity scopes select an entity first
 * (`config.player.for(player).allowGifts.get()`), which yields the identical tree shape.
 */
export interface Config<I extends ConfigDefinition> {
  server: ScopeTree<SafeServer<I>>;
  dimension: EntityScope<SafeDimension<I>, Dimension>;
  player: EntityScope<SafePlayer<I>, Player>;
}

// ─── Announcements ─────────────────────────────────────────────────────────────

/** A flat map whose keys carry a scope prefix; the entries are the renderer's to read, so only the envelope is checked. */
function isFlatMap<T>(value: unknown): value is Record<string, T> {
  return isRecord(value);
}

/** One flat map with `server.` / `dimension.` / `player.` prefixed onto every key. */
function scoped<T>(server: Record<string, T>, dimension: Record<string, T>, player: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};

  for (const [k, v] of Object.entries(server)) { out[`server.${k}`] = v; }

  for (const [k, v] of Object.entries(dimension)) { out[`dimension.${k}`] = v; }

  for (const [k, v] of Object.entries(player)) { out[`player.${k}`] = v; }

  return out;
}

/** What a remote accessor reads and calls through. */
interface RemoteSource {
  rpc: Rpc;
  schema: Announcement<FlatSchema>;
  groups: Announcement<FlatGroups>;
}

// ─── Remote config accessor (untyped) ─────────────────────────────────────────

/**
 * Untyped view of another addon's config. The schema is read synchronously from the shared
 * mirror; values are fetched and written through the endpoints the owner's runtime serves —
 * `patch` merges deep, `set` replaces (missing keys revert to schema defaults). Reads and writes
 * resolve with the scope's effective value, defaults filled.
 *
 * An accessor obtained with an `actorId` acts **on behalf of that player**, and the owning addon
 * authorizes every request against them (see `authorization.ts`). Without one the accessor acts
 * as the addon itself, which is unrestricted — see that file for why.
 */
export class RemoteConfigAccessor {
  private readonly _source: RemoteSource;
  private readonly _addonId: string;
  private readonly _actorId: string | undefined;

  readonly server = {
    get: async (): Promise<unknown> => this._call('server', 'get', undefined, {}),
    patch: async (value: Record<string, unknown>): Promise<unknown> => this._call('server', 'patch', undefined, { changes: value }),
    set: async (value: Record<string, unknown>): Promise<unknown> => this._call('server', 'set', undefined, { doc: value }),
  };

  readonly dimension = {
    get: async (dimId: string): Promise<unknown> => this._call('dimension', 'get', dimId, {}),
    patch: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this._call('dimension', 'patch', dimId, { changes: value }),
    set: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this._call('dimension', 'set', dimId, { doc: value }),
  };

  readonly player = {
    get: async (playerId: string): Promise<unknown> => this._call('player', 'get', playerId, {}),
    patch: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this._call('player', 'patch', playerId, { changes: value }),
    set: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this._call('player', 'set', playerId, { doc: value }),
  };

  constructor(source: RemoteSource, addonId: string, actorId?: string) {
    this._source = source;
    this._addonId = addonId;
    this._actorId = actorId;
  }

  /** Schema with `server.`/`dimension.`/`player.` prefixes on every key. Used by UI to determine scope. */
  get scopedSchema(): FlatSchema {
    return this._source.schema.of(this._addonId) ?? {};
  }

  /**
   * Group display strings with the same scope prefixes {@link scopedSchema} carries.
   *
   * Empty for an addon that names no group, and for one running a runtime that predates the
   * key — both mean the same thing to a reader: fall back to the key-derived title.
   */
  get scopedGroups(): FlatGroups {
    return this._source.groups.of(this._addonId) ?? {};
  }

  /** Unprefixed flat schema, derived from {@link scopedSchema} by stripping the scope segment. */
  get schema(): FlatSchema {
    const flat: FlatSchema = {};

    for (const [key, entry] of Object.entries(this.scopedSchema)) {
      const dot = key.indexOf('.');

      flat[dot === -1 ? key : key.slice(dot + 1)] = entry;
    }

    return flat;
  }

  private async _call(
    scope: ConfigScopeName,
    operation: 'get' | 'patch' | 'set',
    target: string | undefined,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const targetParam = TARGET_PARAM[scope];
    const response = await this._source.rpc.request(this._addonId, configMethod(scope, operation), {
      ...params,
      ...(targetParam === undefined ? {} : { [targetParam]: target }),
      actorId: this._actorId,
    });

    return this._shape(scope, response);
  }

  /**
   * A response as the scope's value: what the owner's scope reads, defaults already filled — or,
   * from a runtime that answers nothing for a target it cannot reach, every default the announced
   * schema declares. `undefined` on a malformed payload.
   */
  private _shape(scope: ConfigScopeName, response: unknown): Record<string, unknown> | undefined {
    if (response === null) { return this._defaults(scope); }

    return isRecord(response) ? response : undefined;
  }

  private _defaults(scope: ConfigScopeName): Record<string, unknown> {
    const prefix = `${scope}.`;
    const nested: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(this.scopedSchema)) {
      if (!key.startsWith(prefix)) { continue; }

      const parts = key.slice(prefix.length).split('.');
      let node = nested;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const next = node[part];

        node = isRecord(next) ? next : (node[part] = {});
      }

      node[parts[parts.length - 1]] = entry.default;
    }

    return nested;
  }
}

// ─── Typed remote config ───────────────────────────────────────────────────────

/**
 * Typed view of another addon's config. Obtain via `core.config.of<I>()` or
 * `core.config.subscribe<I>()`. Reads and writes go over RPC; `patch` merges a
 * partial, `set` replaces the whole scope (full object required). `get` resolves
 * `undefined` on a malformed response.
 */
export type TypedRemoteConfig<I extends ConfigDefinition> = {
  server: {
    get(): Promise<SchemaToValue<SafeServer<I>> | undefined>;
    patch(partial: DeepPartial<SchemaToValue<SafeServer<I>>>): Promise<unknown>;
    set(value: SchemaToValue<SafeServer<I>>): Promise<unknown>;
  };
  dimension: {
    get(dimId: string): Promise<SchemaToValue<SafeDimension<I>> | undefined>;
    patch(dimId: string, partial: DeepPartial<SchemaToValue<SafeDimension<I>>>): Promise<unknown>;
    set(dimId: string, value: SchemaToValue<SafeDimension<I>>): Promise<unknown>;
  };
  player: {
    get(playerId: string): Promise<SchemaToValue<SafePlayer<I>> | undefined>;
    patch(playerId: string, partial: DeepPartial<SchemaToValue<SafePlayer<I>>>): Promise<unknown>;
    set(playerId: string, value: SchemaToValue<SafePlayer<I>>): Promise<unknown>;
  };
  schema: FlatSchema;
};

// ─── ConfigRegistry ────────────────────────────────────────────────────────────

/**
 * This addon's own scopes, narrowed to what a generic consumer can use without knowing the
 * schema's type. `core.config.local` hands these out so tooling built on top of the runtime —
 * config commands, debug screens — can enumerate and edit local config from a plain `Runtime`,
 * which the strongly-typed value `register()` returns is not reachable from.
 *
 * Writes go through the same `patch` the typed accessors use, so persistence, change events
 * and revert-to-default all behave identically.
 */
export interface LocalConfigScopes {
  server: { readonly schema: FlatSchema; get(): unknown; patch(partial: Record<string, unknown>): void };
  dimension: { readonly schema: FlatSchema; get(entity: Dimension): unknown; patch(entity: Dimension, partial: Record<string, unknown>): void };
  player: { readonly schema: FlatSchema; get(entity: Player): unknown; patch(entity: Player, partial: Record<string, unknown>): void };
}

/** Options for {@link ConfigRegistry.of}. */
export interface ConfigAccessOptions {
  /**
   * The player this access is made on behalf of. Present for anything a player drives (a UI
   * screen, a config command); absent for an addon acting on its own behalf.
   */
  actorId?: string;
}

/** This addon's config — schema, scopes, methods — and a view of every other addon's. */
export class ConfigRegistry {
  /**
   * Every addon's schema, flat and scope-prefixed, announced under `core-config/schema` one tick
   * after it registers. Its presence is the "this addon has config" signal.
   */
  readonly schema: Announcement<FlatSchema>;

  /**
   * The display strings of the groups those keys nest under, announced under
   * `core-config/groups` with the same prefixes. Empty for an addon that names no group, which a
   * reader takes as: fall back to the key-derived title.
   */
  readonly groups: Announcement<FlatGroups>;

  private readonly _node: SyncNode;
  private readonly _db: Db;
  private readonly _remote: RemoteSource;
  private _defined = false;
  private _local: LocalConfigScopes | undefined;
  private readonly _disposers: Unsubscribe[] = [];

  constructor(node: SyncNode, addonId: string, db: Db) {
    this._node = node;
    this._db = db;
    this.schema = new Announcement<FlatSchema>(node.state, addonId, 'config/schema', isFlatMap);
    this.groups = new Announcement<FlatGroups>(node.state, addonId, 'config/groups', isFlatMap);
    this._remote = { rpc: node.rpc, schema: this.schema, groups: this.groups };
  }

  stop(): void {
    for (const d of this._disposers.splice(0)) { d(); }
  }

  /**
   * Define this addon's config, once. Called by the `config(definition)` declaration as it installs.
   * Returns the typed scope accessors (`config.server`, `config.dimension`, `config.player`).
   */
  define<I extends ConfigDefinition>(input: I): Config<I> {
    if (this._defined) { throw new Error('core.config.define() called more than once'); }

    // Scope schemas are groups without the display strings; the index signature is the same.
    const serverTree = (input.server ?? {}) as SchemaGroup;
    const dimensionTree = (input.dimension ?? {}) as SchemaGroup;
    const playerTree = (input.player ?? {}) as SchemaGroup;

    // Before anything is built, and before the registry marks itself defined: a key that
    // collides with an accessor verb has no sane runtime recovery, so the declaration is
    // rejected outright.
    validateConfigSchema('server', serverTree);
    validateConfigSchema('dimension', dimensionTree);
    validateConfigSchema('player', playerTree);

    this._defined = true;

    const serverFlat = flattenSchema(serverTree);
    const dimensionFlat = flattenSchema(dimensionTree);
    const playerFlat = flattenSchema(playerTree);

    const serverDefaults = defaultsOf(serverTree);
    const dimensionDefaults = defaultsOf(dimensionTree);
    const playerDefaults = defaultsOf(playerTree);

    // ─── Collections ─────────────────────────────────────────────────────────────
    // One document schema per scope: the same version and steps, told which scope's document
    // they are looking at; that scope's defaults; and the write pass over its entries.

    const documentSchema = (scope: ConfigScopeName, tree: SchemaGroup, defaults: ConfigDocument): Schema<ConfigDocument> => schema<ConfigDocument>({
      version: input.version,
      migrate: migrationsFor(input.migrate, scope),
      defaults,
      normalize: normalizeAgainst(tree),
    });

    const collections = {
      server: this._db.collection(CONFIG_COLLECTIONS.server, { schema: documentSchema('server', serverTree, serverDefaults), accept: worldTarget() }),
      dimension: this._db.collection(CONFIG_COLLECTIONS.dimension, { schema: documentSchema('dimension', dimensionTree, dimensionDefaults), accept: dimensions() }),
      player: this._db.collection(CONFIG_COLLECTIONS.player, { schema: documentSchema('player', playerTree, playerDefaults), accept: players() }),
    };

    // ─── Scopes ───────────────────────────────────────────────────────────────────

    const gate: Gate = { ready: false };
    const server = serverScope<SafeServer<I>, World>(collections.server, world, serverTree, serverDefaults, serverFlat, gate);
    const dimension = new EntityScope<SafeDimension<I>, Dimension>(collections.dimension, dimensionTree, dimensionDefaults, dimensionFlat, gate);
    const player = new EntityScope<SafePlayer<I>, Player>(collections.player, playerTree, playerDefaults, playerFlat, gate);

    // ─── RPC ─────────────────────────────────────────────────────────────────────
    // What the config UI in another realm calls. A read answers the scope's effective value; a
    // write applies through the same tree the owner uses — so `normalize` coerces it — and answers
    // what the tree now reads, which is read-after-write in one round trip.
    //
    // The player rule runs first, on every one: the world and a dimension are an operator's to
    // change, a player's own scope is theirs, and a request with no actor is an addon acting for
    // itself. A refusal is thrown, so the caller's promise rejects with the reason.

    type Changes = Record<string, unknown>;

    const asChanges = (value: unknown): Changes => (isRecord(value) ? value : {});
    // The trees are typed against the schema; a document off the wire is a record the write pass
    // will coerce anyway.
    const patchOf = (value: unknown): DeepPartial<SchemaToValue<SafeServer<I>>> => asChanges(value) as DeepPartial<SchemaToValue<SafeServer<I>>>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    const docOf = (value: unknown): SchemaToValue<SafeServer<I>> => asChanges(value) as SchemaToValue<SafeServer<I>>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

    const requireDimension = (dimId: string): Dimension => {
      try {
        return world.getDimension(dimId);
      } catch {
        throw new Error(`no dimension named '${dimId}'`);
      }
    };

    const requirePlayer = (playerId: string): Player => {
      const found = world.getAllPlayers().find(candidate => candidate.id === playerId);

      if (!isUsable(found)) { throw new Error(`player '${playerId}' is not in the world`); }

      return found;
    };

    const actorOf = (params: unknown): string | undefined => {
      const actorId = isRecord(params) ? params.actorId : undefined;

      return typeof actorId === 'string' ? actorId : undefined;
    };

    const idOf = (params: unknown, key: string): string => {
      const value = isRecord(params) ? params[key] : undefined;

      if (typeof value !== 'string') { throw new Error(`'${key}' is required`); }

      return value;
    };

    const changesOf = (params: unknown, key: 'changes' | 'doc'): Changes => asChanges(isRecord(params) ? params[key] : undefined);

    const method = (name: string, handler: (params: unknown) => unknown): void => {
      this._disposers.push(this._node.rpc.onRequest(name, handler));
    };

    method(configMethod('server', 'get'), (params): unknown => {
      authorize({ world: true }, actorOf(params), 'read');

      return server.get();
    });

    method(configMethod('server', 'patch'), (params): unknown => {
      authorize({ world: true }, actorOf(params), 'write');
      server.patch(patchOf(changesOf(params, 'changes')));

      return server.get();
    });

    method(configMethod('server', 'set'), (params): unknown => {
      authorize({ world: true }, actorOf(params), 'write');
      server.set(docOf(changesOf(params, 'doc')));

      return server.get();
    });

    method(configMethod('dimension', 'get'), (params): unknown => {
      const dimId = idOf(params, 'dimId');

      authorize({ dimension: dimId }, actorOf(params), 'read');

      return dimension.for(requireDimension(dimId)).get();
    });

    method(configMethod('dimension', 'patch'), (params): unknown => {
      const dimId = idOf(params, 'dimId');

      authorize({ dimension: dimId }, actorOf(params), 'write');

      const tree = dimension.for(requireDimension(dimId));

      tree.patch(patchOf(changesOf(params, 'changes')));

      return tree.get();
    });

    method(configMethod('dimension', 'set'), (params): unknown => {
      const dimId = idOf(params, 'dimId');

      authorize({ dimension: dimId }, actorOf(params), 'write');

      const tree = dimension.for(requireDimension(dimId));

      tree.set(docOf(changesOf(params, 'doc')));

      return tree.get();
    });

    method(configMethod('player', 'get'), (params): unknown => {
      const playerId = idOf(params, 'playerId');

      authorize({ entity: playerId }, actorOf(params), 'read');

      return player.for(requirePlayer(playerId)).get();
    });

    method(configMethod('player', 'patch'), (params): unknown => {
      const playerId = idOf(params, 'playerId');

      authorize({ entity: playerId }, actorOf(params), 'write');

      const tree = player.for(requirePlayer(playerId));

      tree.patch(patchOf(changesOf(params, 'changes')));

      return tree.get();
    });

    method(configMethod('player', 'set'), (params): unknown => {
      const playerId = idOf(params, 'playerId');

      authorize({ entity: playerId }, actorOf(params), 'write');

      const tree = player.for(requirePlayer(playerId));

      tree.set(docOf(changesOf(params, 'doc')));

      return tree.get();
    });

    // Dynamic properties are readable from tick 1 onward. Until then every tree answers with the
    // defaults; opening the gate reads what is stored, and the subscribers attached during
    // registration hear the values that differ. The schema reaches peers on the same tick.
    system.run(() => {
      gate.ready = true;
      server.get();
      dimension.warm();
      player.warm();

      this.schema.provide(scoped(serverFlat, dimensionFlat, playerFlat));
      this.groups.provide(scoped(flattenGroups(serverTree), flattenGroups(dimensionTree), flattenGroups(playerTree)));
    });

    // A tree kept for a player who left would answer for a handle that is no longer usable.
    const onLeave = world.afterEvents.playerLeave.subscribe(({ playerId }) => {
      player.forgetId(playerId);
    });

    this._disposers.push(() => { world.afterEvents.playerLeave.unsubscribe(onLeave); });

    this._local = { server, dimension, player };

    return { server, dimension, player };
  }

  /**
   * This addon's own config scopes, or `undefined` before `define()` has run. Available
   * synchronously — unlike {@link of}, which needs the schema to have reached the mirror one
   * tick later — so startup-time consumers such as command registration can read it.
   */
  get local(): LocalConfigScopes | undefined {
    return this._local;
  }

  /**
   * View another addon's config. Pass `{ actorId }` when the reads and writes are being made
   * on behalf of a player — a UI screen, a command — so the owning addon authorizes them
   * against that player. Omit it for programmatic access, which is unrestricted.
   */
  of(addonId: string, options?: ConfigAccessOptions): RemoteConfigAccessor | undefined;
  of<I extends ConfigDefinition>(addonId: string, options?: ConfigAccessOptions): TypedRemoteConfig<I> | undefined;
  of(addonId: string, options?: ConfigAccessOptions): unknown {
    if (this.schema.of(addonId) === undefined) { return undefined; }

    return new RemoteConfigAccessor(this._remote, addonId, options?.actorId);
  }

  /**
   * Called with an accessor as soon as `addonId` has announced a schema — now, if it already has
   * — and again whenever it announces a new one.
   */
  subscribe(addonId: string, listener: (cfg: RemoteConfigAccessor) => void): Unsubscribe;
  subscribe<I extends ConfigDefinition>(addonId: string, listener: (cfg: TypedRemoteConfig<I>) => void): Unsubscribe;
  subscribe(addonId: string, listener: unknown): Unsubscribe {
    // TypedRemoteConfig<I> is a compile-time view over RemoteConfigAccessor (the same
    // runtime object); the accessor's private fields keep TS from relating the two types.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const cb = listener as (cfg: RemoteConfigAccessor) => void;

    const notify = (): void => { cb(new RemoteConfigAccessor(this._remote, addonId)); };

    if (this.schema.of(addonId) !== undefined) { notify(); }

    return this.schema.subscribe((namespace) => {
      if (namespace === addonId && this.schema.of(addonId) !== undefined) { notify(); }
    });
  }
}

/** The definition's steps as db takes them, each told which scope's document it is given. */
function migrationsFor(
  steps: ConfigDefinition['migrate'],
  scope: ConfigScopeName,
): Record<number, MigrateStep> | undefined {
  if (steps === undefined) { return undefined; }

  const bound: Record<number, MigrateStep> = {};

  for (const [version, step] of Object.entries(steps)) {
    bound[Number(version)] = (doc): Record<string, unknown> => step(doc, scope);
  }

  return bound;
}
