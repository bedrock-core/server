/**
 * ConfigRegistry — the config subsystem of the bedrock-core Runtime.
 *
 * Accessible as `core.config` after `core.register()`.
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
import { DimensionTypes, system, world } from '@minecraft/server';
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
  broadcastScopedSchema,
  broadcastServerValues,
  broadcastDimensionValues,
  broadcastPlayerValues,
  broadcastDimensionRoster,
  broadcastPlayerRoster as broadcastPlayerRosterState,
  BC_CONFIG_SCHEMA,
  BC_CONFIG_SCOPED_SCHEMA,
  BC_CONFIG_SERVER,
  BC_CONFIG_DIMENSIONS,
  BC_CONFIG_PLAYERS,
  dimValuesKey,
  playerValuesKey,
  type RosterEntry,
} from './broadcast';
import { ServerConfigScope, EntityConfigScope } from './scopes';
import { buildNestedObject } from './scopes/utils';
import { flattenObject } from './scopes/utils';
import { registerConfigRpc } from './rpc';

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
 * Reads are synchronous (from the state mirror); writes go through RPC.
 */
export class RemoteConfigAccessor {
  private readonly node: SyncNode;
  private readonly addonId: string;

  readonly server = {
    get: (): unknown => {
      const flat = this.node.state.get(this.addonId, BC_CONFIG_SERVER);

      return flat ? buildNestedObject(flat, this.schema) : undefined;
    },
    patch: async (value: Record<string, unknown>): Promise<unknown> => this.node.rpc.request(this.addonId, 'bc:config.patch', Object.fromEntries(flattenObject(value))),
    set: async (value: Record<string, unknown>): Promise<unknown> => this.node.rpc.request(this.addonId, 'bc:config.patch', Object.fromEntries(flattenObject(value))),
  };

  readonly dimension = {
    get: (dimId: string): unknown => {
      const flat = this.node.state.get(this.addonId, dimValuesKey(dimId));

      return flat ? buildNestedObject(flat, this.schema) : undefined;
    },
    patch: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this.node.rpc.request(this.addonId, 'bc:config.patch-dim', { dimId, values: Object.fromEntries(flattenObject(value)) }),
    set: async (dimId: string, value: Record<string, unknown>): Promise<unknown> => this.node.rpc.request(this.addonId, 'bc:config.patch-dim', { dimId, values: Object.fromEntries(flattenObject(value)) }),
  };

  readonly player = {
    get: (playerId: string): unknown => {
      const flat = this.node.state.get(this.addonId, playerValuesKey(playerId));

      return flat ? buildNestedObject(flat, this.schema) : undefined;
    },
    patch: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this.node.rpc.request(this.addonId, 'bc:config.patch-player', { playerId, values: Object.fromEntries(flattenObject(value)) }),
    set: async (playerId: string, value: Record<string, unknown>): Promise<unknown> => this.node.rpc.request(this.addonId, 'bc:config.patch-player', { playerId, values: Object.fromEntries(flattenObject(value)) }),
  };

  constructor(node: SyncNode, addonId: string) {
    this.node = node;
    this.addonId = addonId;
  }

  get schema(): FlatSchema {
    return this.node.state.get(this.addonId, BC_CONFIG_SCHEMA) ?? {};
  }

  /** Schema with `server.`/`dimension.`/`player.` prefixes on every key. Used by UI to determine scope. */
  get scopedSchema(): FlatSchema {
    return this.node.state.get(this.addonId, BC_CONFIG_SCOPED_SCHEMA) ?? {};
  }

  /** Known dimensions, for a UI picker. */
  get dimensionRoster(): RosterEntry[] {
    return this.node.state.get(this.addonId, BC_CONFIG_DIMENSIONS) ?? [];
  }

  /** Currently online players, for a UI picker. */
  get playerRoster(): RosterEntry[] {
    return this.node.state.get(this.addonId, BC_CONFIG_PLAYERS) ?? [];
  }
}

// ─── Typed remote config ───────────────────────────────────────────────────────

/**
 * Typed read+write view of another addon's config.
 * Obtain via `core.config.of<I>()` or `core.config.subscribe<I>()`.
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
  private readonly node: SyncNode;
  private readonly addonId: string;
  private _defined = false;
  private readonly addonConfigListeners = new Map<string, Set<(cfg: RemoteConfigAccessor) => void>>();
  private readonly disposers: Unsubscribe[] = [];
  private readonly onlinePlayers = new Map<string, Player>();

  constructor(node: SyncNode, addonId: string) {
    this.node = node;
    this.addonId = addonId;
  }

  start(): void {
    this.disposers.push(
      this.node.state.onChange((change) => {
        if (change.ns !== this.addonId && change.key === BC_CONFIG_SCHEMA && !change.deleted) {
          const listeners = this.addonConfigListeners.get(change.ns);

          if (listeners?.size) {
            const accessor = new RemoteConfigAccessor(this.node, change.ns);

            for (const l of listeners) { l(accessor); }
          }
        }
      }),
    );
  }

  stop(): void {
    for (const d of this.disposers.splice(0)) { d(); }
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
    const fullSchema: FlatSchema = { ...serverFlat, ...dimensionFlat, ...playerFlat };

    const serverValues = new Map<string, ConfigValue>(
      Object.entries(serverFlat).map(([k, e]) => [k, e.default]),
    );
    const dimensionValues = new Map<string, Map<string, ConfigValue>>();
    const playerValues = new Map<string, Map<string, ConfigValue>>();

    // ─── Scope accessors ────────────────────────────────────────────────────────

    const serverScope = new ServerConfigScope<NonNullable<I['server']>>(
      serverTree,
      serverFlat,
      serverValues,
      (key, value) => {
        saveServerValue(this.addonId, key, value);
        broadcastServerValues(this.node.state, this.addonId, serverValues);
      },
    );

    const dimensionScope = new EntityConfigScope<NonNullable<I['dimension']>, Dimension>(
      dimensionTree,
      dimensionFlat,
      dimensionValues,
      (dimId, key, value) => {
        saveDimensionValue(this.addonId, dimId, key, value);
        this.broadcastEffectiveDim(dimId, dimensionFlat, dimensionValues);
      },
    );

    const playerScope = new EntityConfigScope<NonNullable<I['player']>, Player>(
      playerTree,
      playerFlat,
      playerValues,
      (playerId, key, value) => {
        const player = this.onlinePlayers.get(playerId);

        if (player) {
          savePlayerValue(player, this.addonId, key, value);
          this.broadcastEffectivePlayer(playerId, playerFlat, playerValues);
        }
      },
    );

    // ─── RPC handlers ───────────────────────────────────────────────────────────

    registerConfigRpc(this.node.rpc, {
      onPatchServer: (flat) => {
        serverScope.applyRemotePatch(flat);

        for (const [key, value] of Object.entries(flat)) { saveServerValue(this.addonId, key, value); }

        broadcastServerValues(this.node.state, this.addonId, serverValues);
      },
      onPatchDimension: (dimId, flat) => {
        dimensionScope.applyRemotePatch(dimId, flat);

        for (const [key, value] of Object.entries(flat)) { saveDimensionValue(this.addonId, dimId, key, value); }

        this.broadcastEffectiveDim(dimId, dimensionFlat, dimensionValues);
      },
      onGetPlayer: playerId => playerScope.getFlat(playerId),
      onPatchPlayer: (playerId, flat) => {
        const player = this.onlinePlayers.get(playerId);

        if (!player) { return; }

        playerScope.applyRemotePatch(playerId, flat);

        for (const [key, value] of Object.entries(flat)) { savePlayerValue(player, this.addonId, key, value); }

        this.broadcastEffectivePlayer(playerId, playerFlat, playerValues);
      },
    });

    // ─── Deferred DP loading ────────────────────────────────────────────────────

    system.run(() => {
      serverScope.loadInitial(loadServerValues(this.addonId, serverFlat));

      if (Object.keys(dimensionFlat).length > 0) {
        for (const dimId of loadedDimensionIds(this.addonId, dimensionFlat)) {
          const loaded = loadDimensionValues(this.addonId, dimId, dimensionFlat);

          if (loaded.size > 0) { dimensionValues.set(dimId, loaded); }
        }

        for (const dimId of dimensionValues.keys()) {
          this.broadcastEffectiveDim(dimId, dimensionFlat, dimensionValues);
        }

        broadcastDimensionRoster(
          this.node.state,
          this.addonId,
          DimensionTypes.getAll().map(d => ({ id: d.typeId, name: d.typeId })),
        );
      }

      broadcastSchema(this.node.state, this.addonId, fullSchema);
      broadcastScopedSchema(this.node.state, this.addonId, serverFlat, dimensionFlat, playerFlat);

      if (Object.keys(serverFlat).length > 0) {
        broadcastServerValues(this.node.state, this.addonId, serverValues);
      }
    });

    // ─── Player lifecycle ────────────────────────────────────────────────────────

    const onSpawn = world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
      if (!initialSpawn) { return; }

      this.onlinePlayers.set(player.id, player);
      this.broadcastPlayerRoster();

      if (Object.keys(playerFlat).length === 0) { return; }

      playerScope.init(player.id, loadPlayerValues(player, this.addonId, playerFlat));
      this.broadcastEffectivePlayer(player.id, playerFlat, playerValues);
    });

    this.disposers.push(() => { world.afterEvents.playerSpawn.unsubscribe(onSpawn); });

    const onLeave = world.beforeEvents.playerLeave.subscribe(({ player }) => {
      this.onlinePlayers.delete(player.id);
      this.broadcastPlayerRoster();

      if (Object.keys(playerFlat).length === 0) { return; }

      playerScope.clear(player.id);
    });

    this.disposers.push(() => { world.beforeEvents.playerLeave.unsubscribe(onLeave); });

    return { server: serverScope, dimension: dimensionScope, player: playerScope };
  }

  of(addonId: string): RemoteConfigAccessor | undefined;
  of<I extends ConfigDefinition>(addonId: string): TypedRemoteConfig<I> | undefined;
  of(addonId: string): unknown {
    if (this.node.state.get(addonId, BC_CONFIG_SCHEMA) === undefined) { return undefined; }

    return new RemoteConfigAccessor(this.node, addonId);
  }

  subscribe(addonId: string, listener: (cfg: RemoteConfigAccessor) => void): Unsubscribe;
  subscribe<I extends ConfigDefinition>(addonId: string, listener: (cfg: TypedRemoteConfig<I>) => void): Unsubscribe;
  subscribe(addonId: string, listener: unknown): Unsubscribe {
    // TypedRemoteConfig<I> is a compile-time view over RemoteConfigAccessor (the same
    // runtime object); the accessor's private fields keep TS from relating the two types.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const cb = listener as (cfg: RemoteConfigAccessor) => void;
    let set = this.addonConfigListeners.get(addonId);

    if (!set) { set = new Set(); this.addonConfigListeners.set(addonId, set); }

    set.add(cb);

    if (this.node.state.get(addonId, BC_CONFIG_SCHEMA) !== undefined) {
      cb(new RemoteConfigAccessor(this.node, addonId));
    }

    return () => { this.addonConfigListeners.get(addonId)?.delete(cb); };
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  private broadcastEffectiveDim(
    dimId: string,
    flat: FlatSchema,
    values: Map<string, Map<string, ConfigValue>>,
  ): void {
    if (Object.keys(flat).length === 0) { return; }

    const effective = new Map<string, ConfigValue>();

    for (const key of Object.keys(flat)) {
      const stored = values.get(dimId)?.get(key);

      if (stored !== undefined) { effective.set(key, stored); continue; }

      const schemaDef = flat[key]?.default;

      if (schemaDef !== undefined) { effective.set(key, schemaDef); }
    }

    broadcastDimensionValues(this.node.state, this.addonId, dimId, effective);
  }

  private broadcastEffectivePlayer(
    playerId: string,
    flat: FlatSchema,
    values: Map<string, Map<string, ConfigValue>>,
  ): void {
    if (Object.keys(flat).length === 0) { return; }

    const effective = new Map<string, ConfigValue>();

    for (const key of Object.keys(flat)) {
      const stored = values.get(playerId)?.get(key);

      if (stored !== undefined) { effective.set(key, stored); continue; }

      const schemaDef = flat[key]?.default;

      if (schemaDef !== undefined) { effective.set(key, schemaDef); }
    }

    broadcastPlayerValues(this.node.state, this.addonId, playerId, effective);
  }

  private broadcastPlayerRoster(): void {
    const roster: RosterEntry[] = [...this.onlinePlayers.values()].map(p => ({ id: p.id, name: p.name }));

    broadcastPlayerRosterState(this.node.state, this.addonId, roster);
  }
}
