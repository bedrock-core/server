/**
 * `core.screens` — an addon's compiled screens, as references another realm can show.
 *
 * A screen is compiled into the addon's own resource pack, so every client already holds what
 * draws it. What a realm needs in order to SHOW one it did not build is small — per screen the
 * compiled title, the value each entry carries and where each press leads — and that is what an
 * addon announces under `core-ui/reference`:
 *
 * ```ts
 * import { uiReference } from '@bedrock-core/generated/ui';
 *
 * core.register({ ..., screens: uiReference() });
 * ```
 *
 * With it published, `navigate('<addon>:<screen>')` works in any realm in the world, whether or
 * not the owner's script is running there. The runtime never looks inside a reference: the
 * renderer owns the shape and narrows it at the point of use.
 */
import type { State } from '@bedrock-core/sync';
import { Announcement, isRecord } from './announcement';

/**
 * What the runtime knows about a screen reference: the envelope. `screens` is
 * `Record<key, ScreenReference>` to the renderer.
 */
export interface AddonScreens {
  v: 1;
  /** The owning addon's UI namespace — the half every one of its keys starts with. */
  ns: string;
  screens: unknown;
}

/** The envelope check `core.screens` reads through. */
export function isAddonScreens(value: unknown): value is AddonScreens {
  return isRecord(value) && typeof value['ns'] === 'string' && isRecord(value['screens']);
}

/** Each addon's screens, announced, with one lookup across all of them. */
export class ScreensRegistry extends Announcement<AddonScreens> {
  constructor(state: State, addonId: string) {
    super(state, addonId, 'ui/reference', isAddonScreens);
  }

  /**
   * The reference for one screen key, from whichever addon published it.
   *
   * Searched rather than parsed out of the key: a key's first half is the owner's UI namespace,
   * which an addon may set apart from the namespace it syncs under, so the only reliable answer
   * is the one the published records give.
   */
  find(key: string): unknown {
    for (const namespace of this.namespaces()) {
      const published = this.of(namespace);
      const screens = published?.screens;

      if (isRecord(screens) && key in screens) {
        return screens[key];
      }
    }

    return undefined;
  }
}
