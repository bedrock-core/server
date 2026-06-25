/**
 * Togglable features driven by a registry condition.
 *
 * A feature declares a `condition(registry): boolean`; the runtime re-evaluates it on every
 * registry change and edge-triggers `onEnable`/`onDisable` when the result flips. This lets an
 * addon light up integrations with other addons only when they're installed.
 */
import type { Registry } from './registry';
import type { Unsubscribe } from '@bedrock-core/sync';

export interface FeatureSpec {

  /** Returns `true` to enable the feature, `false` to disable. Re-evaluated on every registry change. */
  condition: (registry: Registry) => boolean;

  onEnable(): void;
  onDisable(): void;
}

interface FeatureState {
  spec: FeatureSpec;
  enabled: boolean;
}

export class FeatureManager {
  private readonly _registry: Registry;
  private readonly _features = new Map<string, FeatureState>();
  private readonly _disposers: Unsubscribe[] = [];

  constructor(registry: Registry) {
    this._registry = registry;
  }

  /** Re-evaluate every feature whenever the set of present addons changes. */
  start(): void {
    this._disposers.push(
      this._registry.onRegister(() => this.evaluateAll()),
      this._registry.onUnregister(() => this.evaluateAll()),
    );
    this.evaluateAll();
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) dispose();
  }

  /** Declare a feature. Evaluated immediately, then on every registry change. */
  add(id: string, spec: FeatureSpec): void {
    this._features.set(id, { spec, enabled: false });
    this.evaluate(id);
  }

  /** Whether a declared feature is currently enabled. */
  isEnabled(id: string): boolean {
    return this._features.get(id)?.enabled ?? false;
  }

  private evaluateAll(): void {
    for (const id of this._features.keys()) this.evaluate(id);
  }

  private evaluate(id: string): void {
    const feature = this._features.get(id);
    if (!feature) return;

    const available = feature.spec.condition(this._registry);
    if (available === feature.enabled) return;

    feature.enabled = available;
    if (available) {
      feature.spec.onEnable();
    } else {
      feature.spec.onDisable();
    }
  }
}
