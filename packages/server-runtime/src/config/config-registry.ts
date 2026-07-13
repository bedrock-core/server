/**
 * ConfigRegistry — the config subsystem of the bedrock-core Runtime.
 *
 * Accessible as `core.config` after `core.register()`.
 *
 * Write semantics (all scopes, local and remote): `patch` deep-merges the provided keys;
 * `set` replaces the whole scope — it requires the full object, and any schema key missing
 * from the payload reverts to its schema default (its persisted override is deleted).
 *
 * Addon defining config:
 * ```ts
 * const config = core.config.define({
 *   server:    { pricing: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
 *   dimension: { miningBonus: { type: 'number', default: 1.0, min: 0, max: 5, label: 'Mining Bonus' } },
 *   player:    { allowGifts: { type: 'boolean', default: true, label: 'Allow Gifts' } },
 * });
 *
 * config.server.get()                            // { pricing: { taxRate: number } }
 * config.server.patch({ pricing: { taxRate: 0.1 } })
 * config.dimension.patch(dim, { miningBonus: 2.0 })
 * config.server.onChange('pricing.taxRate', (next, prev) => { ... })
 * config.server.onChange(full => console.warn(full.pricing.taxRate))
 * ```
 *
 * Cross-addon access:
 * ```ts
 * const shopCfg = core.config.of<ShopConfigDef>('vendor:bc_shop');
 * shopCfg?.server.get()                          // structured, typed
 * await shopCfg?.server.patch({ pricing: { taxRate: 0.1 } })
 * ```
 */
import { system, world } from '@minecraft/server';
import type { Dimension, Player } from '@minecraft/server';
import type { StateKey, SyncNode, Unsubscribe } from '@bedrock-core/sync';
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
import {
  broadcastSchema,
  broadcastServerValues,
  BC_CONFIG_SCHEMA,
  BC_CONFIG_SERVER,
  dimValuesKey,
  playerValuesKey,
} from './broadcast';
import { ServerConfigScope, EntityConfigScope } from './scopes';
import { buildNestedObject, flattenObject } from './scopes/utils';
import { registerConfigRpc } from './rpc';

type Flat = Record<string, ConfigValue>;

// ─── Return types ──────────────────────────────────────────────────────────────

type SafeServer<I extends ConfigDefinition>
  = NonNullable<I['server']> extends ServerScopeSchema ? NonNullable<I['server']> : Record<never, never>;
type SafeDimension<I extends ConfigDefinition>
  = NonNullable<I['dimension']> extends DimensionScopeSchema ? NonNullable<I['dimension']> : Record<never, never>;
type SafePlayer<I extends ConfigDefinition>
  = NonNullable<I['player']> extends PlayerScopeSchema ? NonNullable<I['player']> : Record<never, never>;

export interface Config<I extends ConfigDefinition> {
  server: ServerConfigScope<SafeServer<I>>;
  dimension: EntityConfigScope<SafeDimension<I>, Dimension>;
  player: EntityConfigScope<SafePlayer<I>, Player>;
}

// ─── Remote config accessor (untyped) ─────────────────────────────────────────

/**
 * Untyped, read+write view of another addon's config.
 * Reads are synchronous (from the state mirror); writes go through RPC —
 * `patch` merges, `set` replaces (missing keys revert to schema defaults).
 */
export class RemoteConfigAccessor {
  private readonly _node: SyncNode;
  private readonly _addonId: string;

  readonly server = {
    get: (): unknown => {
      const flat = this._node.state.get(this._addonId, BC_CONFIG_SERVER);

      return flat ? buildNestedObject(flat, this.schema) : undefined;
    },
    patch: async (value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'bc:config.patch', Object.fromEntries(flattenObject(value))),
    set: async (value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'bc:config.set', Object.fromEntries(flattenObject(value))),
  };

  readonly dimension = {
    get: (dimId: string): unknown => {
      const flat = this._node.state.get(this._addonId, dimValuesKey(dimId));

      return flat ? buildNestedObject(flat, this.schema) : undefined;
    },
    patch: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'bc:config.patch-dim', { dimId, values: Object.fromEntries(flattenObject(value)) }),
    set: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'bc:config.set-dim', { dimId, values: Object.fromEntries(flattenObject(value)) }),
  };

  readonly player = {
    get: (playerId: string): unknown => {
      const flat = this._node.state.get(this._addonId, playerValuesKey(playerId));

      return flat ? buildNestedObject(flat, this.schema) : undefined;
    },
    patch: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'bc:config.patch-player', { playerId, values: Object.fromEntries(flattenObject(value)) }),
    set: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this._node.rpc.request(this._addonId, 'bc:config.set-player', { playerId, values: Object.fromEntries(flattenObject(value)) }),
  };

  constructor(node: SyncNode, addonId: string) {
    this._node = node;
    this._addonId = addonId;
  }

  /** Schema with `server.`/`dimension.`/`player.` prefixes on every key. Used by UI to determine scope. */
  get scopedSchema(): FlatSchema {
    return this._node.state.get(this._addonId, BC_CONFIG_SCHEMA) ?? {};
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
}

// ─── Typed remote config ───────────────────────────────────────────────────────

/**
 * Typed read+write view of another addon's config.
 * Obtain via `core.config.of<I>()` or `core.config.subscribe<I>()`.
 * `patch` merges a partial; `set` replaces the whole scope (full object required).
 */
export type TypedRemoteConfig<I extends ConfigDefinition> = {
  server: {
    get(): SchemaToValue<SafeServer<I>>;
    patch(partial: DeepPartial<SchemaToValue<SafeServer<I>>>): Promise<unknown>;
    set(value: SchemaToValue<SafeServer<I>>): Promise<unknown>;
  };
  dimension: {
    get(dimId: string): SchemaToValue<SafeDimension<I>>;
    patch(dimId: string, partial: DeepPartial<SchemaToValue<SafeDimension<I>>>): Promise<unknown>;
    set(dimId: string, value: SchemaToValue<SafeDimension<I>>): Promise<unknown>;
  };
  player: {
    get(playerId: string): SchemaToValue<SafePlayer<I>>;
    patch(playerId: string, partial: DeepPartial<SchemaToValue<SafePlayer<I>>>): Promise<unknown>;
    set(playerId: string, value: SchemaToValue<SafePlayer<I>>): Promise<unknown>;
  };
  schema: FlatSchema;
};

// ─── ConfigRegistry ────────────────────────────────────────────────────────────

export class ConfigRegistry {
  private readonly _node: SyncNode;
  private readonly _addonId: string;
  private _defined = false;
  private readonly _addonConfigListeners = new Map<string, Set<(cfg: RemoteConfigAccessor) => void>>();
  private readonly _disposers: Unsubscribe[] = [];
  private readonly _onlinePlayers = new Map<string, Player>();

  constructor(node: SyncNode, addonId: string) {
    this._node = node;
    this._addonId = addonId;
  }

  start(): void {
    this._disposers.push(
      this._node.state.onChange((change) => {
        if (change.ns !== this._addonId && change.key === BC_CONFIG_SCHEMA && !change.deleted) {
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
   * Define this addon's config. Call once, after `core.register()`. Returns typed
   * scope accessors (`config.server`, `config.dimension`, `config.player`).
   */
  define<I extends ConfigDefinition>(input: I): Config<I> {
    if (this._defined) { throw new Error('core.config.define() called more than once'); }

    this._defined = true;

    const serverTree = (input.server ?? {}) as Record<string, SchemaNode>;
    const dimensionTree = (input.dimension ?? {}) as Record<string, SchemaNode>;
    const playerTree = (input.player ?? {}) as Record<string, SchemaNode>;

    const serverFlat = flattenSchema(serverTree);
    const dimensionFlat = flattenSchema(dimensionTree);
    const playerFlat = flattenSchema(playerTree);

    const serverValues = new Map<string, ConfigValue>(
      Object.entries(serverFlat).map(([k, e]) => [k, e.default]),
    );
    const dimensionValues = new Map<string, Map<string, ConfigValue>>();
    const playerValues = new Map<string, Map<string, ConfigValue>>();

    // ─── Scope accessors ────────────────────────────────────────────────────────
    // Each scope hands applied batches back here for persistence + broadcast; an
    // `undefined` value in a batch deletes the persisted override (set-revert).

    const serverScope = new ServerConfigScope<NonNullable<I['server']>>(
      serverTree,
      serverFlat,
      serverValues,
      (changes) => {
        for (const [key, value] of changes) { saveServerValue(this._addonId, key, value); }

        broadcastServerValues(this._node.state, this._addonId, serverValues);
      },
    );

    const dimensionScope = new EntityConfigScope<NonNullable<I['dimension']>, Dimension>(
      dimensionTree,
      dimensionFlat,
      dimensionValues,
      (dimId, changes) => {
        for (const [key, value] of changes) { saveDimensionValue(this._addonId, dimId, key, value); }

        this.broadcastEffective(dimId, dimensionFlat, dimensionValues, dimValuesKey);
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

        this.broadcastEffective(playerId, playerFlat, playerValues, playerValuesKey);
      },
    );

    // ─── RPC handlers ───────────────────────────────────────────────────────────
    // Persistence + broadcast run through the scopes' apply callbacks above.

    const requireOnline = (playerId: string, method: string): boolean => {
      if (this._onlinePlayers.has(playerId)) { return true; }

      console.warn(`[bedrock-core] '${this._addonId}' config: ${method} for offline player '${playerId}' ignored`);

      return false;
    };

    registerConfigRpc(this._node.rpc, {
      onPatchServer: flat => serverScope.applyRemotePatch(flat),
      onSetServer: flat => serverScope.applyRemoteSet(flat),
      onPatchDimension: (dimId, flat) => dimensionScope.applyRemotePatch(dimId, flat),
      onSetDimension: (dimId, flat) => dimensionScope.applyRemoteSet(dimId, flat),
      onGetPlayer: playerId => playerScope.getFlat(playerId),
      onPatchPlayer: (playerId, flat) => {
        if (requireOnline(playerId, 'patch')) { playerScope.applyRemotePatch(playerId, flat); }
      },
      onSetPlayer: (playerId, flat) => {
        if (requireOnline(playerId, 'set')) { playerScope.applyRemoteSet(playerId, flat); }
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

        for (const dimId of dimensionValues.keys()) {
          this.broadcastEffective(dimId, dimensionFlat, dimensionValues, dimValuesKey);
        }
      }

      // Seed players that are already connected — after a script reload (e.g. /reload)
      // no playerSpawn fires for them, so relying on the event alone would leave
      // player-scope config dead until they rejoin.
      for (const player of world.getAllPlayers()) {
        this._onlinePlayers.set(player.id, player);

        if (Object.keys(playerFlat).length > 0) {
          playerScope.init(player.id, loadPlayerValues(player, this._addonId, playerFlat));
          this.broadcastEffective(player.id, playerFlat, playerValues, playerValuesKey);
        }
      }

      broadcastSchema(this._node.state, this._addonId, serverFlat, dimensionFlat, playerFlat);

      if (Object.keys(serverFlat).length > 0) {
        broadcastServerValues(this._node.state, this._addonId, serverValues);
      }
    });

    // ─── Player lifecycle ────────────────────────────────────────────────────────

    const onSpawn = world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
      if (!initialSpawn) { return; }

      this._onlinePlayers.set(player.id, player);

      if (Object.keys(playerFlat).length === 0) { return; }

      playerScope.init(player.id, loadPlayerValues(player, this._addonId, playerFlat));
      this.broadcastEffective(player.id, playerFlat, playerValues, playerValuesKey);
    });

    this._disposers.push(() => { world.afterEvents.playerSpawn.unsubscribe(onSpawn); });

    const onLeave = world.afterEvents.playerLeave.subscribe(({ playerId }) => {
      this._onlinePlayers.delete(playerId);

      if (Object.keys(playerFlat).length === 0) { return; }

      playerScope.clear(playerId);
    });

    this._disposers.push(() => { world.afterEvents.playerLeave.unsubscribe(onLeave); });

    return { server: serverScope, dimension: dimensionScope, player: playerScope };
  }

  of(addonId: string): RemoteConfigAccessor | undefined;
  of<I extends ConfigDefinition>(addonId: string): TypedRemoteConfig<I> | undefined;
  of(addonId: string): unknown {
    if (this._node.state.get(addonId, BC_CONFIG_SCHEMA) === undefined) { return undefined; }

    return new RemoteConfigAccessor(this._node, addonId);
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

    if (this._node.state.get(addonId, BC_CONFIG_SCHEMA) !== undefined) {
      cb(new RemoteConfigAccessor(this._node, addonId));
    }

    return () => { this._addonConfigListeners.get(addonId)?.delete(cb); };
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  /** Publish an entity's effective values (stored override → schema default) under its state key. */
  private broadcastEffective(
    entityId: string,
    flat: FlatSchema,
    values: Map<string, Map<string, ConfigValue>>,
    keyFor: (id: string) => StateKey<Flat>,
  ): void {
    if (Object.keys(flat).length === 0) { return; }

    const effective: Flat = {};

    for (const key of Object.keys(flat)) {
      const value = values.get(entityId)?.get(key) ?? flat[key]?.default;

      if (value !== undefined) { effective[key] = value; }
    }

    this._node.state.set(this._addonId, keyFor(entityId), effective);
  }
}
