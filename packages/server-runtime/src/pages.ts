/**
 * `core.pages` — an addon's page in the shared addon list, as a reference.
 *
 * The page is a compiled screen baked into the addon's own pack, drawn into the host's list by
 * every client that holds the pack. What the host needs to draw it is small — per reserved
 * entry, the value it is shown with and where a press leads — and that is what an addon
 * announces under `core-addon/page`.
 *
 * The page follows from the manifest, so an addon's build compiles one and `ui()` announces it;
 * declaring is all it takes. An addon that wants a page of its own writes the screen and names
 * it here instead, and the build generates none:
 *
 * ```ts
 * import { addonPageReference } from '@bedrock-core/config/compiled';
 * import AddonPage from './screens/addon.screen';
 *
 * core.register({ ..., page: addonPageReference(AddonPage) });
 * ```
 *
 * The runtime never looks inside a reference; `@bedrock-core/config` owns the shape and narrows
 * it at the point of use.
 */
import { isRecord } from './announcement';

/** What the runtime knows about a page reference: the envelope. The renderer owns the real shape. */
export interface AddonPageReference {
  v: 1;
  /** Per reserved entry, the value it is shown with. `string[]` to the renderer. */
  values: unknown;
  /** Per reserved entry, where a press leads. To the renderer. */
  targets: unknown;
}

/** The envelope check `core.pages` reads through. */
export function isAddonPageReference(value: unknown): value is AddonPageReference {
  return isRecord(value) && 'values' in value && 'targets' in value;
}
