/**
 * `core.features` — togglable behavior driven by a condition over the registry and the mirror.
 *
 * A feature declares a `condition(ctx): boolean`; the runtime re-evaluates it on every registry
 * or mirror change and edge-triggers `onEnable` / `onDisable` when the result flips. The enabled
 * flags are announced under `core-feature/flags` as one record, so a peer's condition can depend
 * on them.
 *
 * ```ts
 * core.features.add('leaderboard-sync', {
 *   condition: ctx => ctx.registry.has('other_studio_leaderboard'),
 *   onEnable() { startSync(); },
 *   onDisable() { stopSync(); },
 * });
 *
 * core.features.add('cross-pvp', {
 *   condition: ctx => ctx.feature('other_studio_pvp', 'arena-mode'),
 *   onEnable() { … },
 *   onDisable() { … },
 * });
 *
 * const pvp = core.features.of<PvpFeatures>('other_studio_pvp');
 * pvp.isEnabled('arena-mode');
 * ```
 */
import type { State, Unsubscribe } from '@bedrock-core/sync';
import { Announcement, isRecord } from './announcement';
import type { Registry } from './registry';

/** Feature id → enabled, the whole record announced on every flip. */
export type FeatureFlags = Record<string, boolean>;

function isFeatureFlags(value: unknown): value is FeatureFlags {
  return isRecord(value) && Object.values(value).every(flag => typeof flag === 'boolean');
}

export interface FeatureConditionContext {
  registry: Registry;
  state: State;
  /** Whether a peer's feature is enabled, read from its announced flags. */
  feature(addonId: string, featureId: string): boolean;
}

export interface FeatureSpec {

  /**
   * Whether the feature should be enabled right now. Re-evaluated on **every** registry and
   * mirror change, so it must be a cheap, pure predicate over `ctx` — no side effects, no
   * expensive work.
   */
  condition(ctx: FeatureConditionContext): boolean;
  onEnable(): void;
  onDisable(): void;
}

export interface TypedFeatureAccessor<T extends string> { isEnabled(id: T): boolean }

interface FeatureState {
  spec: FeatureSpec;
  enabled: boolean;
}

export class FeatureManager {
  /** Every addon's flags, this one's included. */
  readonly flags: Announcement<FeatureFlags>;

  private readonly _registry: Registry;
  private readonly _state: State;
  private readonly _features = new Map<string, FeatureState>();
  private readonly _disposers: Unsubscribe[] = [];

  constructor(registry: Registry, state: State, addonId: string) {
    this._registry = registry;
    this._state = state;
    this.flags = new Announcement<FeatureFlags>(state, addonId, 'feature/flags', isFeatureFlags);
  }

  start(): void {
    this._disposers.push(
      this._registry.onRegister(() => this.evaluateAll()),
      this._registry.onUnregister(() => this.evaluateAll()),
      // Every mirror change, since a condition may read any announced value. Announcing a flag
      // cannot loop: evaluate() returns before publishing when the result has not flipped.
      this._state.subscribe(() => this.evaluateAll()),
    );
    this.evaluateAll();
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }
  }

  /** Declare a feature. Evaluated immediately, then on every registry or mirror change. */
  add(id: string, spec: FeatureSpec): void {
    this._features.set(id, { spec, enabled: false });
    this.evaluate(id);
  }

  /** Whether a local feature is currently enabled. */
  isEnabled(id: string): boolean {
    return this._features.get(id)?.enabled ?? false;
  }

  /** A typed reader over another addon's announced flags; synchronous, from the local mirror. */
  of<T extends string = string>(addonId: string): TypedFeatureAccessor<T> {
    return { isEnabled: (id: T) => this.flagOf(addonId, id) };
  }

  private flagOf(addonId: string, featureId: string): boolean {
    return this.flags.of(addonId)?.[featureId] === true;
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
      feature: (addonId, featureId) => this.flagOf(addonId, featureId),
    };

    const available = feature.spec.condition(ctx);

    if (available === feature.enabled) { return; }

    feature.enabled = available;

    const flags: FeatureFlags = {};

    for (const [featureId, entry] of this._features) { flags[featureId] = entry.enabled; }

    this.flags.provide(flags);

    if (available) {
      feature.spec.onEnable();
    } else {
      feature.spec.onDisable();
    }
  }
}
