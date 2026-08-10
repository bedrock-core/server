/**
 * The declaration an addon makes when it registers with the runtime. This is the "base
 * data" that flows into the cross-addon registry, analogous to a pack manifest.
 *
 * ## Identity is one namespace, declared in two halves
 *
 * Minecraft's rule for add-ons is that every item in a pack shares a single namespace, that no
 * two packs may share one, and that it should read as creator-then-pack — `bt_gc_graves` for
 * Bedrock Tweaks' graves addon. That namespace is this addon's identity everywhere: its sync
 * transport id, its replicated state, its custom commands, and its command enums.
 *
 * It is declared as **`creator` + `pack`** rather than as one string so the halves stay
 * machine-readable — the registry groups by creator, and a UI can show them apart — and
 * {@link addonNamespace} joins them. Two addons collide only if both halves match.
 *
 * `name` and `creatorName` are purely human-readable display labels.
 */
import { RUNTIME_VERSION } from './runtime-version';

export interface AddonManifest {

  /** Creator/vendor id, lowercase alphanumeric + underscores (e.g. `bt` for Bedrock Tweaks). */
  creator: string;

  /**
   * Creator display name. Assumed to be a Minecraft translation key (e.g.
   * `bt.gc_graves.creator`) shipped in this addon's RP .lang — registry UIs render
   * it per player language. Plain text also works: Bedrock falls back to the literal
   * string when no .lang entry matches. Optional.
   */
  creatorName?: string;

  /**
   * Abbreviated pack id, lowercase alphanumeric + underscores (e.g. `gc_graves` — gameplay
   * changes, graves). Joined to `creator` as `creator_pack` to form this addon's namespace.
   */
  pack: string;

  /**
   * Pack display name. Assumed to be a translation key (see `creatorName` for the contract,
   * e.g. `bt.gc_graves.name`); plain text falls back to the literal. Not part of identity.
   */
  packName: string;

  /** Addon version (free-form, e.g. semver). */
  version: string;

  /** Assumed to be a translation key (see `creatorName` for the contract). */
  description?: string;

  /** Namespaces (`creator_pack`, e.g. `bt_gc_economy`) this addon needs present (soft — warns, never blocks). */
  dependencies?: string[];

  /** Namespaces that unlock optional, togglable features when present. */
  optionalDependencies?: string[];

  /** Resource-pack texture path for the registry UI icon (e.g. `textures/ui/my_addon_logo`). */
  icon?: string;

  /** Resource-pack texture path for the registry UI thumbnail banner, 16:9 (e.g. `textures/ui/my_addon_thumbnail`). */
  thumbnail?: string;
}

/**
 * The manifest fields carried in the discovery `meta` blob — everything but `version`,
 * which discovery carries on its own. The node id is the addon's namespace; `creator` and
 * `pack` ride along so peers can recover the halves without splitting a string that has no
 * unambiguous split point. The index signature makes the blob assignable to the transport's
 * opaque meta type.
 *
 * `runtimeVersion` is added by the runtime rather than declared by the addon: it is the
 * version of `@bedrock-core/server-runtime` the addon was built against, and the host
 * election compares it across realms.
 */
export type ManifestMeta = Omit<AddonManifest, 'version'> & {
  runtimeVersion: string;
  [key: string]: unknown;
};

// Lowercase alphanumeric + underscores, at least one character.
const ID_PATTERN = /^[a-z0-9_]+$/;

/**
 * Validate and normalize a manifest. Throws a descriptive error on invalid input so a
 * misconfigured addon fails loudly at registration rather than silently misbehaving.
 */
export function validateManifest(input: AddonManifest): AddonManifest {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('addon manifest must be an object');
  }

  const creator = requireString(input.creator, 'creator');

  if (!ID_PATTERN.test(creator)) {
    throw new Error(`invalid creator '${creator}': must be lowercase alphanumeric and underscores only (a-z0-9_)`);
  }

  const pack = requireString(input.pack, 'pack');

  if (!ID_PATTERN.test(pack)) {
    throw new Error(`invalid pack '${pack}': must be lowercase alphanumeric and underscores only (a-z0-9_)`);
  }

  const manifest: AddonManifest = {
    creator,
    pack,
    packName: requireString(input.packName, 'packName'),
    version: requireString(input.version, 'version'),
  };

  if (input.creatorName !== undefined) { manifest.creatorName = String(input.creatorName); }

  if (input.description !== undefined) { manifest.description = String(input.description); }

  if (input.dependencies !== undefined) { manifest.dependencies = stringArray(input.dependencies, 'dependencies'); }

  if (input.optionalDependencies !== undefined) {
    manifest.optionalDependencies = stringArray(input.optionalDependencies, 'optionalDependencies');
  }

  if (input.icon !== undefined) { manifest.icon = String(input.icon); }

  if (input.thumbnail !== undefined) { manifest.thumbnail = String(input.thumbnail); }

  return manifest;
}

/**
 * This addon's namespace: `${creator}_${pack}`, e.g. `bt_gc_graves`.
 *
 * The one identifier the addon is known by — sync transport id, replicated state namespace,
 * custom command namespace, command enum namespace. Minecraft requires a pack to use exactly
 * one and no two packs to share it, which is the same uniqueness the registry already enforces
 * on `creator` + `pack`, so there is nothing else to reconcile.
 */
export function addonNamespace(manifest: AddonManifest): string {
  return `${manifest.creator}_${manifest.pack}`;
}

/** Extract the discovery `meta` blob from a manifest, stamping the runtime version peers elect on. */
export function manifestToMeta(manifest: AddonManifest): ManifestMeta {
  const meta: ManifestMeta = {
    creator: manifest.creator,
    pack: manifest.pack,
    packName: manifest.packName,
    runtimeVersion: RUNTIME_VERSION,
  };

  if (manifest.creatorName !== undefined) { meta.creatorName = manifest.creatorName; }

  if (manifest.description !== undefined) { meta.description = manifest.description; }

  if (manifest.dependencies !== undefined) { meta.dependencies = manifest.dependencies; }

  if (manifest.optionalDependencies !== undefined) { meta.optionalDependencies = manifest.optionalDependencies; }

  if (manifest.icon !== undefined) { meta.icon = manifest.icon; }

  if (manifest.thumbnail !== undefined) { meta.thumbnail = manifest.thumbnail; }

  return meta;
}

/**
 * Reconstruct a manifest from a peer's namespace + discovery fields + `meta` blob.
 *
 * The halves come from `meta` rather than from splitting `namespace`: `bt_gc_graves` has no
 * unambiguous split point, so a peer that published no meta keeps its whole namespace as `pack`
 * and an empty `creator` instead of being guessed at.
 */
export function manifestFromPeer(
  namespace: string,
  version: string,
  meta: Record<string, unknown> | undefined,
): AddonManifest {
  const pack = typeof meta?.pack === 'string' ? meta.pack : namespace;
  const manifest: AddonManifest = {
    creator: typeof meta?.creator === 'string' ? meta.creator : '',
    pack,
    packName: typeof meta?.packName === 'string' ? meta.packName : pack,
    version,
  };

  if (typeof meta?.creatorName === 'string') { manifest.creatorName = meta.creatorName; }

  if (typeof meta?.description === 'string') { manifest.description = meta.description; }

  if (typeof meta?.icon === 'string') { manifest.icon = meta.icon; }

  if (typeof meta?.thumbnail === 'string') { manifest.thumbnail = meta.thumbnail; }

  if (Array.isArray(meta?.dependencies)) {
    manifest.dependencies = meta.dependencies.filter((d): d is string => typeof d === 'string');
  }

  if (Array.isArray(meta?.optionalDependencies)) {
    manifest.optionalDependencies = meta.optionalDependencies.filter((d): d is string => typeof d === 'string');
  }

  return manifest;
}

/**
 * The runtime version a peer announced. Defaults to `0.0.0` when the field is missing or
 * malformed, which makes that peer lose the host election rather than corrupt it.
 */
export function runtimeVersionFromPeer(meta: Record<string, unknown> | undefined): string {
  return typeof meta?.runtimeVersion === 'string' ? meta.runtimeVersion : '0.0.0';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`addon manifest '${field}' is required and must be a non-empty string`);
  }

  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw new Error(`addon manifest '${field}' must be an array of strings`);
  }

  return value;
}
