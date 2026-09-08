/**
 * `core.guides` — an addon's in-game guide, announced as a reference.
 *
 * A guide compiles into screens baked into the addon's own pack, so every client already holds
 * what it says. What the elected host needs to *present* it is small — per screen a compiled
 * title, the entry values and where each press leads — and that is the reference an addon
 * announces under `core-guide/reference`, `guideReference(ns)` from `@bedrock-core/guides`:
 *
 * ```ts
 * core.register({ ..., guideReference: guideReference(core.id) });
 * ```
 *
 * The runtime never looks inside one: the renderer owns the real shape and narrows it at the
 * point of use with `isGuideReference`. The same holds for {@link GuidesRegistry.manifest}, the
 * whole compiled manifest an addon built before compiled guides announces instead.
 */
import type { State } from '@bedrock-core/sync';
import { Announcement, isRecord } from './announcement';

/**
 * What the runtime knows about a guide reference: the envelope. `pages` is
 * `Record<PageId, GuideScreenReference>` to the renderer.
 */
export interface GuideReference {
  v: 1;
  /** The owning addon's namespace. */
  ns: string;
  pages: unknown;
}

/**
 * What the runtime knows about a guide manifest: a sidebar tree and a page table. Structural on
 * purpose and with no index signature — the renderer's richer `GuideManifest` is an interface,
 * so an index signature here would make `core.register({ guide })` reject the very manifests
 * the filter produces. `tree` is `GuideTreeNode[]` and `pages` is `Record<PageId, GuidePageData>`
 * to the renderer.
 */
export interface GuideManifest {
  tree: unknown;
  pages: unknown;
}

export function isGuideReference(value: unknown): value is GuideReference {
  return isRecord(value) && typeof value['ns'] === 'string' && 'pages' in value;
}

export function isGuideManifest(value: unknown): value is GuideManifest {
  return isRecord(value) && 'tree' in value && 'pages' in value;
}

export class GuidesRegistry extends Announcement<GuideReference> {
  /** The whole compiled manifest, for an addon that presents from one rather than a reference. */
  readonly manifest: Announcement<GuideManifest>;

  constructor(state: State, addonId: string) {
    super(state, addonId, 'guide/reference', isGuideReference);
    this.manifest = new Announcement<GuideManifest>(state, addonId, 'guide/manifest', isGuideManifest);
  }
}
