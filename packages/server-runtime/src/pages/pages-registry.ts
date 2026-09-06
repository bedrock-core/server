/**
 * Cross-addon page references.
 *
 * An addon's page in the shared addon list is a compiled screen baked in the
 * addon's own pack, drawn into the host's list by every client that holds
 * the pack. What the host needs to draw it is small — per reserved entry, the
 * value it is shown with and where a press leads — and that is what an addon
 * publishes here, the way it publishes its guide reference:
 *
 * ```ts
 * import { addonPageReference } from '@bedrock-core/config/compiled';
 * import AddonPage from './screens/addon.screen';
 *
 * core.register({ ..., page: addonPageReference(AddonPage) });
 * ```
 *
 * The runtime never looks inside a reference; `@bedrock-core/config` owns the
 * shape and narrows it at the point of use. Late joiners are covered by
 * sync's state snapshot exchange.
 */
import { stateKey } from '@bedrock-core/sync';
import type { State } from '@bedrock-core/sync';

/**
 * What the runtime knows about a page reference: the envelope. The renderer
 * owns the real shape, as with a guide reference.
 */
export interface AddonPageReference {
  v: 1;
  /** Per reserved entry, the value it is shown with. `string[]` to the renderer. */
  values: unknown;
  /** Per reserved entry, where a press leads. To the renderer. */
  targets: unknown;
}

/** State key an addon publishes its page reference under (namespace = the addon's). */
const PAGE_REFERENCE_STATE_KEY = stateKey<AddonPageReference>('core-addon/page');

export class PagesRegistry {
  private readonly _state: State;
  private readonly _addonId: string;

  constructor(state: State, addonId: string) {
    this._state = state;
    this._addonId = addonId;
  }

  /**
   * Publish this addon's page reference so the elected host can draw its page
   * in the addon list. Usually declared up front via `core.register({ page })`;
   * call directly to publish late or replace it.
   */
  provide(reference: AddonPageReference): void {
    this._state.set(this._addonId, PAGE_REFERENCE_STATE_KEY, reference);
  }

  /** The reference another addon published, or `undefined`. Local-mirror read, shallow-guarded. */
  of(addonId: string): AddonPageReference | undefined {
    const value = this._state.get(addonId, PAGE_REFERENCE_STATE_KEY);

    if (typeof value !== 'object' || value === null) { return undefined; }

    if (!('values' in value) || !('targets' in value)) { return undefined; }

    return value;
  }
}
