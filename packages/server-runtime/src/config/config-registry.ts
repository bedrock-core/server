/**
 * ConfigRegistry — the config subsystem of the bedrock-core Runtime.
 *
 * Accessible as `core.config` after `core.register()`.
 *
 * Discovery is push, values are pull: each addon publishes only its (small, static)
 * schema to replicated state; values live with the owning addon and are fetched on
 * demand via RPC. Write semantics (all scopes, local and remote): `patch` deep-merges
 * the provided keys; `set` replaces the whole scope — it requires the full object, and
 * any schema key missing from the payload reverts to its schema default (its persisted
 * override is deleted).
 *
 * Addon defining config (usually via the `config` field of `core.register()`, which
 * delegates here and returns the same typed accessors):
 * ```ts
 * const config = core.register({
 *   // ...identity fields...
 *   config: {
 *     server:    { pricing: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
 *     dimension: { miningBonus: { type: 'number', default: 1.0, min: 0, max: 5, label: 'Mining Bonus' } },
 *     player:    { allowGifts: { type: 'boolean', default: true, label: 'Allow Gifts' } },
 *   },
 * });
 *
 * // Every scope is a dotted accessor tree mirroring the schema — every node, group or leaf,
 * // carries get / set / subscribe (groups also patch), in the style of
 * // world.afterEvents.playerSpawn.subscribe(...). Entity scopes pick the entity with for().
 * config.server.pricing.taxRate.get()            // number — local, sync
 * config.server.pricing.taxRate.set(0.1)
 * config.server.pricing.taxRate.subscribe((next, prev) => { ... })
 * config.server.pricing.subscribe(pricing => { ... })
 * config.player.for(player).allowGifts.get()
 *
 * config.server.get()                            // { pricing: { taxRate: number } } — whole scope
 * config.server.patch({ pricing: { taxRate: 0.1 } })
 * config.dimension.patch(dim, { miningBonus: 2.0 })
 * config.server.subscribe('pricing.taxRate', (next, prev) => { ... })   // runtime-computed path
 * config.server.subscribe(full => console.warn(full.pricing.taxRate))
 * ```
 *
 * Cross-addon access (reads and writes go over RPC):
 * ```ts
 * const shopCfg = core.config.of<ShopConfigDef>('vendor_shop');
 * await shopCfg?.server.get()                    // structured, typed
 * await shopCfg?.server.patch({ pricing: { taxRate: 0.1 } })
 * ```
 */
import { system, world } from '@minecraft/server';
import type { Dimension, Player } from '@minecraft/server';
import type { SyncNode, Unsubscribe } from '@bedrock-core/sync';
import {
  type ConfigDefinition,
  type ConfigValue,
  type FlatSchema,
  type SchemaNode,
  type SchemaToValue,
  type DeepPartial,
  type ServerScopeSchema,
  type DimensionScopeSchema,
  type PlayerScopeSchema,
  flattenSchema,
  validateConfigSchema,
} from './schema';
import {
  loadServerValues,
  loadDimensionValues,
  loadPlayerValues,
  saveServerValue,
  saveDimensionValue,
  savePlayerValue,
  loadedDimensionIds,
} from './persistence';
import { broadcastSchema, CONFIG_SCHEMA_KEY } from './broadcast';
import { ServerConfigScope, EntityConfigScope, type ServerConfigTree } from './scopes';
import { buildNestedObject, flattenObject } from './scopes/utils';
import { registerConfigRpc } from './rpc';
import { denyReason, type ConfigScopeName } from './authorization';

type Flat = Record<string, ConfigValue>;

/** True when an RPC response is a flat dot-path → primitive config map. */
function isFlatValues(value: unknown): value is Flat {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return false; }

  for (const entry of Object.values(value)) {
    if (typeof entry !== 'boolean' && typeof entry !== 'number' && typeof entry !== 'string') { return false; }
  }

  return true;
}

// ─── Return types ──────────────────────────────────────────────────────────────

type SafeServer<I extends ConfigDefinition>
  = NonNullable<I['server']> extends ServerScopeSchema ? NonNullable<I['server']> : Record<never, never>;
type SafeDimension<I extends ConfigDefinition>
  = NonNullable<I['dimension']> extends DimensionScopeSchema ? NonNullable<I['dimension']> : Record<never, never>;
type SafePlayer<I extends ConfigDefinition>
  = NonNullable<I['player']> extends PlayerScopeSchema ? NonNullable<I['player']> : Record<never, never>;

/**
 * This addon's own scopes, as returned by `register({ config })` / `define()`.
 *
 * `server` is the scope *and* its accessor tree — `config.server.get()` alongside
 * `config.server.pricing.taxRate.get()`. The entity scopes select an entity first
 * (`config.player.for(player).allowGifts.get()`), which yields the identical tree shape.
 */
export interface Config<I extends ConfigDefinition> {
  server: ServerConfigTree<SafeServer<I>>;
  dimension: EntityConfigScope<SafeDimension<I>, Dimension>;
  player: EntityConfigScope<SafePlayer<I>, Player>;
}

// ─── Remote config accessor (untyped) ─────────────────────────────────────────

/**
 * Untyped view of another addon's config. The schema is read synchronously from the
 * state mirror; values are fetched (and written) via RPC — `patch` merges, `set`
 * replaces (missing keys revert to schema defaults). Writes resolve with the updated
 * effective flat values.
 *
 * An accessor obtained with an `actorId` acts **on behalf of that player**, and the owning
 * addon authorizes every request against them (see `authorization.ts`). Without one the
 * accessor acts as the addon itself, which is unrestricted — see that file for why.
 *
 * The actor rides along in the request payload, which is why server-scope writes wrap their
 * flat map in `values` instead of being the params (see `rpc.ts`).
 */
export class RemoteConfigAccessor {
  private readonly _node: SyncNode;
  private readonly _addonId: string;
  private readonly _actorId: string | undefined;

  readonly server = {
    get: async (): Promise<unknown> => this.nested(await this._node.rpc.request(this._addonId, 'core:config.get-server', {})),
    patch: async (value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'core:config.patch', { values: Object.fromEntries(flattenObject(value)), actorId: this._actorId }),
    set: async (value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'core:config.set', { values: Object.fromEntries(flattenObject(value)), actorId: this._actorId }),
  };

  readonly dimension = {
    get: async (dimId: string): Promise<unknown> => this.nested(await this._node.rpc.request(this._addonId, 'core:config.get-dim', { dimId })),
    patch: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'core:config.patch-dim', { dimId, values: Object.fromEntries(flattenObject(value)), actorId: this._actorId }),
    set: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'core:config.set-dim', { dimId, values: Object.fromEntries(flattenObject(value)), actorId: this._actorId }),
  };

  readonly player = {
    get: async (playerId: string): Promise<unknown> => this.nested(await this._node.rpc.request(this._addonId, 'core:config.get-player', { playerId, actorId: this._actorId })),
    patch: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'core:config.patch-player', { playerId, values: Object.fromEntries(flattenObject(value)), actorId: this._actorId }),
    set: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'core:config.set-player', { playerId, values: Object.fromEntries(flattenObject(value)), actorId: this._actorId }),
  };

  constructor(node: SyncNode, addonId: string, actorId?: string) {
    this._node = node;
    this._addonId = addonId;
    this._actorId = actorId;
  }

  /** Schema with `server.`/`dimension.`/`player.` prefixes on every key. Used by UI to determine scope. */
  get scopedSchema(): FlatSchema {
    return this._node.state.get(this._addonId, CONFIG_SCHEMA_KEY) ?? {};
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

  /** Shape a get-response into the nested value object, or `undefined` on a malformed payload. */
  private nested(response: unknown): Record<string, unknown> | undefined {
    return isFlatValues(response) ? buildNestedObject(response, this.schema) : undefined;
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

export class ConfigRegistry {
  private readonly _node: SyncNode;
  private readonly _addonId: string;
  private _defined = false;
  private _local: LocalConfigScopes | undefined;
  private readonly _addonConfigListeners = new Map<string, Set<(cfg: RemoteConfigAccessor) => void>>();
  private readonly _disposers: Unsubscribe[] = [];
  private readonly _onlinePlayers = new Map<string, Player>();

  constructor(node: SyncNode, addonId: string) {
    this._node = node;
    this._addonId = addonId;
  }

  start(): void {
    this._disposers.push(
      this._node.state.subscribe((change) => {
        if (change.ns !== this._addonId && change.key === CONFIG_SCHEMA_KEY && !change.deleted) {
          const listeners = this._addonConfigListeners.get(change.ns);

          if (listeners?.size) {
            const accessor = new RemoteConfigAccessor(this._node, change.ns);

            for (const l of listeners) { l(accessor); }
          }
        }
      }),
    );
  }

  stop(): void {
    for (const d of this._disposers.splice(0)) { d(); }
  }

  /**
   * Define this addon's config. Call once — usually implicitly, via the `config` field of
   * `core.register()`; call directly only to define late. Returns typed scope accessors
   * (`config.server`, `config.dimension`, `config.player`).
   */
  define<I extends ConfigDefinition>(input: I): Config<I> {
    if (this._defined) { throw new Error('core.config.define() called more than once'); }

    const serverTree = (input.server ?? {}) as Record<string, SchemaNode>;
    const dimensionTree = (input.dimension ?? {}) as Record<string, SchemaNode>;
    const playerTree = (input.player ?? {}) as Record<string, SchemaNode>;

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

    const serverValues = new Map<string, ConfigValue>(
      Object.entries(serverFlat).map(([k, e]) => [k, e.default]),
    );
    const dimensionValues = new Map<string, Map<string, ConfigValue>>();
    const playerValues = new Map<string, Map<string, ConfigValue>>();

    // ─── Scope accessors ────────────────────────────────────────────────────────
    // Each scope hands applied batches back here for persistence; an `undefined`
    // value in a batch deletes the persisted override (set-revert). No broadcast —
    // consumers fetch values via the RPC handlers below.

    // The constructor assigns one accessor node per top-level schema key onto the instance;
    // TS cannot see properties produced by a schema walk, so this widening is inherent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const serverScope = new ServerConfigScope<SafeServer<I>>(
      serverTree,
      serverFlat,
      serverValues,
      (changes) => {
        for (const [key, value] of changes) { saveServerValue(this._addonId, key, value); }
      },
    ) as ServerConfigTree<SafeServer<I>>;

    const dimensionScope = new EntityConfigScope<NonNullable<I['dimension']>, Dimension>(
      dimensionTree,
      dimensionFlat,
      dimensionValues,
      (dimId, changes) => {
        for (const [key, value] of changes) { saveDimensionValue(this._addonId, dimId, key, value); }
      },
    );

    const playerScope = new EntityConfigScope<NonNullable<I['player']>, Player>(
      playerTree,
      playerFlat,
      playerValues,
      (playerId, changes) => {
        const player = this._onlinePlayers.get(playerId);

        if (!player) {
          console.warn(`[bedrock-core] '${this._addonId}' config: player '${playerId}' is offline; values not persisted`);

          return;
        }

        for (const [key, value] of changes) { savePlayerValue(player, this._addonId, key, value); }
      },
    );

    // ─── RPC handlers ───────────────────────────────────────────────────────────
    // Every handler responds with the scope's updated effective values, so remote
    // callers get read-after-write in one round trip.

    const requireOnline = (playerId: string, method: string): boolean => {
      if (this._onlinePlayers.has(playerId)) { return true; }

      console.warn(`[bedrock-core] '${this._addonId}' config: ${method} for offline player '${playerId}' ignored`);

      return false;
    };

    // Throwing rejects the RPC, so the caller learns why instead of watching a write silently
    // do nothing. A request with no actor is an addon acting for itself and passes untouched.
    const requireAllowed = (scope: ConfigScopeName, actorId: string | undefined, targetId?: string): void => {
      const reason = denyReason(scope, actorId, targetId);

      if (reason !== undefined) {
        throw new Error(`'${this._addonId}' config: ${scope} request refused - ${reason}`);
      }
    };

    registerConfigRpc(this._node.rpc, {
      onGetServer: () => serverScope.getFlat(),
      onPatchServer: (flat, actorId) => {
        requireAllowed('server', actorId);
        serverScope.applyRemotePatch(flat);

        return serverScope.getFlat();
      },
      onSetServer: (flat, actorId) => {
        requireAllowed('server', actorId);
        serverScope.applyRemoteSet(flat);

        return serverScope.getFlat();
      },
      onGetDimension: dimId => dimensionScope.getFlat(dimId),
      onPatchDimension: (dimId, flat, actorId) => {
        requireAllowed('dimension', actorId);
        dimensionScope.applyRemotePatch(dimId, flat);

        return dimensionScope.getFlat(dimId);
      },
      onSetDimension: (dimId, flat, actorId) => {
        requireAllowed('dimension', actorId);
        dimensionScope.applyRemoteSet(dimId, flat);

        return dimensionScope.getFlat(dimId);
      },
      // Reads are unrestricted for server and dimension — those are world settings, not
      // secrets. One player's settings are another matter, so this scope checks reads too.
      onGetPlayer: (playerId, actorId) => {
        requireAllowed('player', actorId, playerId);

        return playerScope.getFlat(playerId);
      },
      onPatchPlayer: (playerId, flat, actorId) => {
        requireAllowed('player', actorId, playerId);

        if (requireOnline(playerId, 'patch')) { playerScope.applyRemotePatch(playerId, flat); }

        return playerScope.getFlat(playerId);
      },
      onSetPlayer: (playerId, flat, actorId) => {
        requireAllowed('player', actorId, playerId);

        if (requireOnline(playerId, 'set')) { playerScope.applyRemoteSet(playerId, flat); }

        return playerScope.getFlat(playerId);
      },
    });

    // ─── Deferred DP loading ────────────────────────────────────────────────────
    // Dynamic properties are readable from tick 1 onward. Loading emits change events
    // for keys whose persisted value differs from the schema default, so subscribers
    // attached right after define() still learn the real values.

    system.run(() => {
      serverScope.loadInitial(loadServerValues(this._addonId, serverFlat));

      if (Object.keys(dimensionFlat).length > 0) {
        for (const dimId of loadedDimensionIds(this._addonId, dimensionFlat)) {
          const loaded = loadDimensionValues(this._addonId, dimId, dimensionFlat);

          if (loaded.size > 0) { dimensionScope.loadInitial(dimId, loaded); }
        }
      }

      // Seed players that are already connected — after a script reload (e.g. /reload)
      // no playerSpawn fires for them, so relying on the event alone would leave
      // player-scope config dead until they rejoin.
      for (const player of world.getAllPlayers()) {
        this._onlinePlayers.set(player.id, player);

        if (Object.keys(playerFlat).length > 0) {
          playerScope.init(player.id, loadPlayerValues(player, this._addonId, playerFlat));
        }
      }

      broadcastSchema(this._node.state, this._addonId, serverFlat, dimensionFlat, playerFlat);
    });

    // ─── Player lifecycle ────────────────────────────────────────────────────────

    const onSpawn = world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
      if (!initialSpawn) { return; }

      this._onlinePlayers.set(player.id, player);

      if (Object.keys(playerFlat).length === 0) { return; }

      playerScope.init(player.id, loadPlayerValues(player, this._addonId, playerFlat));
    });

    this._disposers.push(() => { world.afterEvents.playerSpawn.unsubscribe(onSpawn); });

    const onLeave = world.afterEvents.playerLeave.subscribe(({ playerId }) => {
      this._onlinePlayers.delete(playerId);

      if (Object.keys(playerFlat).length === 0) { return; }

      playerScope.clear(playerId);
    });

    this._disposers.push(() => { world.afterEvents.playerLeave.unsubscribe(onLeave); });

    this._local = { server: serverScope, dimension: dimensionScope, player: playerScope };

    return { server: serverScope, dimension: dimensionScope, player: playerScope };
  }

  /**
   * This addon's own config scopes, or `undefined` before `define()` has run. Available
   * synchronously — unlike {@link of}, which needs the schema to have reached replicated state
   * one tick later — so startup-time consumers such as command registration can read it.
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
    if (this._node.state.get(addonId, CONFIG_SCHEMA_KEY) === undefined) { return undefined; }

    return new RemoteConfigAccessor(this._node, addonId, options?.actorId);
  }

  subscribe(addonId: string, listener: (cfg: RemoteConfigAccessor) => void): Unsubscribe;
  subscribe<I extends ConfigDefinition>(addonId: string, listener: (cfg: TypedRemoteConfig<I>) => void): Unsubscribe;
  subscribe(addonId: string, listener: unknown): Unsubscribe {
    // TypedRemoteConfig<I> is a compile-time view over RemoteConfigAccessor (the same
    // runtime object); the accessor's private fields keep TS from relating the two types.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const cb = listener as (cfg: RemoteConfigAccessor) => void;
    let set = this._addonConfigListeners.get(addonId);

    if (!set) { set = new Set(); this._addonConfigListeners.set(addonId, set); }

    set.add(cb);

    if (this._node.state.get(addonId, CONFIG_SCHEMA_KEY) !== undefined) {
      cb(new RemoteConfigAccessor(this._node, addonId));
    }

    return () => { this._addonConfigListeners.get(addonId)?.delete(cb); };
  }
}
