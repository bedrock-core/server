/**
 * Cross-addon guide sync.
 *
 * A guide is a compiled {@link GuideManifest} (the `guides` Regolith filter output,
 * `@bedrock-core/generated/guides`). Each addon publishes its manifest to replicated state,
 * so the elected host realm can list and render every addon's guide locally.
 *
 * Each addon publishes under its own namespace, so sync's late-join snapshot
 * exchange replicates guides for free:
 *
 * ```ts
 * import guides from '@bedrock-core/generated/guides';
 *
 * core.register({ ..., guide: guides });        // manifest from the filter
 * core.guides.provideManifest(guides);          // or publish/replace later
 * ```
 *
 * Late joiners are covered by sync's state snapshot exchange.
 */
import { stateKey } from '@bedrock-core/sync';
import type { State, Unsubscribe } from '@bedrock-core/sync';
import type { GuideManifest, GuideReference } from './types';

/** State key an addon publishes its compiled manifest under (namespace = the addon's namespace). */
const GUIDE_MANIFEST_STATE_KEY = stateKey<GuideManifest>('core-guide/manifest');

/**
 * State key an addon publishes its guide REFERENCE under: what the elected
 * host needs to show the addon's compiled guide with native forms alone. An
 * addon whose guide compiles publishes this beside, or instead of, the
 * manifest — a host that finds it presents from it and renders nothing.
 */
const GUIDE_REFERENCE_STATE_KEY = stateKey<GuideReference>('core-guide/reference');

export type GuidesChangeListener = () => void;

export class GuidesRegistry {
  private readonly _state: State;
  private readonly _addonId: string;
  private readonly _listeners = new Set<GuidesChangeListener>();
  private readonly _disposers: Unsubscribe[] = [];
  private _addons: string[] | undefined;

  constructor(state: State, addonId: string) {
    this._state = state;
    this._addonId = addonId;
  }

  start(): void {
    this._disposers.push(
      this._state.subscribe((change) => {
        if (change.key !== GUIDE_MANIFEST_STATE_KEY && change.key !== GUIDE_REFERENCE_STATE_KEY) { return; }

        this._addons = undefined;
        this.emitChange();
      }),
    );
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    this._listeners.clear();
    this._addons = undefined;
  }

  /**
   * Publish this addon's compiled guide manifest to replicated state so peers can render it
   * without an RPC round-trip. Usually declared up front via `core.register({ guide })`;
   * call directly to publish late or replace it.
   */
  provideManifest(manifest: GuideManifest): void {
    this._state.set(this._addonId, GUIDE_MANIFEST_STATE_KEY, manifest);
  }

  /**
   * Publish this addon's guide reference — `guideReference(ns)` from
   * `@bedrock-core/guides`, once its compiled screens are registered — so
   * peers can present the guide from it. Usually declared up front via
   * `core.register({ guideReference })`; call directly to publish late or replace it.
   */
  provideReference(reference: GuideReference): void {
    this._state.set(this._addonId, GUIDE_REFERENCE_STATE_KEY, reference);
  }

  /** The reference another addon published, or `undefined`. Local-mirror read, shallow-guarded. */
  referenceOf(addonId: string): GuideReference | undefined {
    const value = this._state.get(addonId, GUIDE_REFERENCE_STATE_KEY);

    if (typeof value !== 'object' || value === null) { return undefined; }

    if (!('ns' in value) || !('pages' in value)) { return undefined; }

    return value;
  }

  /** This addon's own manifest, or `undefined` if it hasn't published one. */
  own(): GuideManifest | undefined {
    return this.of(this._addonId);
  }

  /** The manifest another addon published, or `undefined`. Local-mirror read, shallow-guarded. */
  of(addonId: string): GuideManifest | undefined {
    return this.manifestFor(addonId);
  }

  /** Every addon that published a guide manifest. Cached; rebuilt on change. */
  addonsWithGuides(): string[] {
    if (this._addons) { return this._addons; }

    const addons: string[] = [];

    for (const ns of this._state.namespaces()) {
      if (this.has(ns)) { addons.push(ns); }
    }

    this._addons = addons;

    return addons;
  }

  /** Whether the given addon published a guide — a manifest to render, or a reference to present. */
  has(addonId: string): boolean {
    return this.manifestFor(addonId) !== undefined || this.referenceOf(addonId) !== undefined;
  }

  /** Notified when any addon's published guide changes (coarse — re-read via `of`/`addonsWithGuides`). */
  subscribe(listener: GuidesChangeListener): Unsubscribe {
    this._listeners.add(listener);

    return (): void => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Shallow envelope check only — the runtime deliberately does not understand the IR. A
   * renderer narrows the payload properly with `isGuideManifest` from `@bedrock-core/guides`.
   */
  private manifestFor(ns: string): GuideManifest | undefined {
    const value = this._state.get(ns, GUIDE_MANIFEST_STATE_KEY);

    if (typeof value !== 'object' || value === null) { return undefined; }

    if (!('tree' in value) || !('pages' in value)) { return undefined; }

    return value;
  }

  private emitChange(): void {
    for (const listener of this._listeners) { listener(); }
  }
}
