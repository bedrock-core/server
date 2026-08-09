/**
 * What the runtime knows about a guide manifest: that it has a sidebar tree and a page table.
 *
 * The framework stores and replicates manifests without ever looking inside one — it never
 * walks a block, resolves a link, or reads a localization key. So the detailed IR is owned by
 * the renderer, `@bedrock-core/guides`, which is the only code that interprets it; keeping a
 * copy here would mean maintaining types this package cannot use and cannot check.
 *
 * That leaves this shape as the storage contract, and it is exactly what
 * {@link GuidesRegistry} already validates on read. Consumers that need the real thing narrow
 * with `isGuideManifest` from `@bedrock-core/guides` at the point of rendering — where the
 * data stops being an opaque payload and starts being a document.
 *
 * Structural on purpose, with no index signature: the renderer's richer `GuideManifest` is an
 * interface, and an interface has no implicit index signature, so adding one here would make
 * `core.register({ guide })` reject the very manifests the filter produces. The extra fields
 * (`v`, `ns`, `defaultLocale`, `locales`) ride along unmentioned and untouched.
 */
export interface GuideManifest {

  /** Sidebar entries in display order. `GuideTreeNode[]` to the renderer. */
  tree: unknown;

  /** Page id → page data. `Record<PageId, GuidePageData>` to the renderer. */
  pages: unknown;
}
