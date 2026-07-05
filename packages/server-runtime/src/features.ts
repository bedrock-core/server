/**
 * Togglable features driven by a condition over registry + state.
 *
 * A feature declares a `condition(ctx): boolean`; the runtime re-evaluates it on every
 * registry or state change and edge-triggers `onEnable`/`onDisable` when the result flips.
 * Each feature's enabled state is published to sync state so other addons can observe it.
 *
 * Local feature:
 * ```ts
 * core.feature('leaderboard-sync', {
 *   condition: ctx => ctx.registry.has('other_studio:bc_leaderboard'),
 *   onEnable() { startSync(); },
 *   onDisable() { stopSync(); },
 * });
 * ```
 *
 * Cross-addon feature check (in a condition):
 * ```ts
 * core.feature('cross-pvp', {
 *   condition: ctx =>
 *     ctx.registry.has('other_studio:bc_pvp') &&
 *     ctx.feature('other_studio:bc_pvp', 'arena-mode'),
 *   onEnable() { /* … *\/ },
 *   onDisable() { /* … *\/ },
 * });
 * ```
 *
 * Typed cross-addon read (outside a condition):
 * ```ts
 * const pvp = core.features.of<PvpFeatures>('other_studio:bc_pvp');
 * pvp.isEnabled('arena-mode');    // type-checked
 * ```
 */
import type { State, Unsubscribe } from '@bedrock-core/sync';
import type { Registry } from './registry';

export const FEATURE_STATE_PREFIX = 'bc-feature/';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FeatureConditionContext {
  registry: Registry;
  state: State;
  feature(addonId: string, featureId: string): boolean;
}

export interface FeatureSpec {
  condition(ctx: FeatureConditionContext): boolean;
  onEnable(): void;
  onDisable(): void;
}

export interface TypedFeatureAccessor<T extends string> { isEnabled(id: T): boolean }

// ─── FeatureManager ───────────────────────────────────────────────────────────

interface FeatureState {
  spec: FeatureSpec;
  enabled: boolean;
}

export class FeatureManager {
  private readonly _registry: Registry;
  private readonly _state: State;
  private readonly _addonId: string;
  private readonly _features = new Map<string, FeatureState>();
  private readonly _disposers: Unsubscribe[] = [];

  constructor(registry: Registry, state: State, addonId: string) {
    this._registry = registry;
    this._state = state;
    this._addonId = addonId;
  }

  start(): void {
    this._disposers.push(
      this._registry.onRegister(() => this.evaluateAll()),
      this._registry.onUnregister(() => this.evaluateAll()),
      this._state.onChange((change) => {
        if (change.key.startsWith(FEATURE_STATE_PREFIX) || !change.key.startsWith('bc-')) {
          this.evaluateAll();
        }
      }),
    );
    this.evaluateAll();
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }
  }

  /** Declare a feature. Evaluated immediately, then on every registry or state change. */
  add(id: string, spec: FeatureSpec): void {
    this._features.set(id, { spec, enabled: false });
    this.evaluate(id);
  }

  /** Whether a local feature is currently enabled. */
  isEnabled(id: string): boolean {
    return this._features.get(id)?.enabled ?? false;
  }

  /**
   * Returns a typed accessor for reading another addon's feature flags.
   * Reads are synchronous from the in-memory state mirror.
   */
  of<T extends string = string>(addonId: string): TypedFeatureAccessor<T> {
    return { isEnabled: (id: T) => this._state.get(addonId, `${FEATURE_STATE_PREFIX}${id}`) === true };
  }

  private evaluateAll(): void {
    for (const id of this._features.keys()) { this.evaluate(id); }
  }

  private evaluate(id: string): void {
    const feature = this._features.get(id);

    if (!feature) { return; }

    const ctx: FeatureConditionContext = {
      registry: this._registry,
      state: this._state,
      feature: (addonId, featureId) => this._state.get(addonId, `${FEATURE_STATE_PREFIX}${featureId}`) === true,
    };

    const available = feature.spec.condition(ctx);

    if (available === feature.enabled) { return; }

    feature.enabled = available;
    this._state.set(this._addonId, `${FEATURE_STATE_PREFIX}${id}`, available);

    if (available) {
      feature.spec.onEnable();
    } else {
      feature.spec.onDisable();
    }
  }
}
