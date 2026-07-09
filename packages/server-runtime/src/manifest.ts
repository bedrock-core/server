/**
 * The declaration an addon makes when it registers with the runtime. This is the "base
 * data" that flows into the cross-addon registry, analogous to a pack manifest.
 *
 * Identity is **`creator` + `namespace`** — both id-safe strings. The transport id is derived
 * as `${creator}:${namespace}` (e.g. `chillcraft_studios:cc_mechs`); two addons collide only
 * if both fields match. `name` and
 * `creatorName` are purely human-readable display labels.
 */

export interface AddonManifest {

  /** Creator/vendor id, lowercase alphanumeric + underscores (e.g. `chillcraft_studios`). */
  creator: string;

  /** Creator display name, free text (e.g. `Chillcraft Studios`). Optional. */
  creatorName?: string;

  /** Addon id, lowercase alphanumeric + underscores (e.g. `bc_economy`). Combined with `creator` to form the unique transport identity. */
  namespace: string;

  /** Human-readable display label (free text, e.g. `My Economy`). Not part of identity. */
  name: string;

  /** Addon version (free-form, e.g. semver). */
  version: string;
  description?: string;

  /** Transport ids (`creator:namespace`, e.g. `drav0011:bc_economy`) this addon needs present (soft — warns, never blocks). */
  dependencies?: string[];

  /** Transport ids that unlock optional, togglable features when present. */
  optionalDependencies?: string[];

  /** Resource-pack texture path for the registry UI icon (e.g. `textures/ui/my_addon_logo`). */
  icon?: string;

  /** Resource-pack texture path for the registry UI thumbnail banner, 16:9 (e.g. `textures/ui/my_addon_thumbnail`). */
  thumbnail?: string;
}

/** The manifest fields carried in the discovery `meta` blob. The node id is the transport id (`creator:namespace`); namespace is also stored here so peers can recover it. */
export interface ManifestMeta {
  creator: string;
  creatorName?: string;
  namespace: string;
  name: string;
  description?: string;
  dependencies?: string[];
  optionalDependencies?: string[];
  icon?: string;
  thumbnail?: string;
  // Index signature so a meta blob is assignable to the transport's opaque meta type.
  [key: string]: unknown;
}

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

  const namespace = requireString(input.namespace, 'namespace');

  if (!ID_PATTERN.test(namespace)) {
    throw new Error(`invalid namespace '${namespace}': must be lowercase alphanumeric and underscores only (a-z0-9_)`);
  }

  const manifest: AddonManifest = {
    creator,
    namespace,
    name: requireString(input.name, 'name'),
    version: requireString(input.version, 'version'),
  };

  if (input.creatorName !== undefined) { manifest.creatorName = String(input.creatorName); }

  if (input.description !== undefined) { manifest.description = String(input.description); }

  if (input.dependencies !== undefined) { manifest.dependencies = stringArray(input.dependencies, 'dependencies'); }

  if (input.optionalDependencies !== undefined) {
    manifest.optionalDependencies = stringArray(input.optionalDependencies, 'optionalDependencies');
  }

  if (input.icon !== undefined) { manifest.icon = String(input.icon); }

  manifest.thumbnail = input.thumbnail ?? '';

  return manifest;
}

/** Derives the SyncNode transport id from a manifest: `${creator}:${namespace}`. */
export function addonTransportId(manifest: AddonManifest): string {
  return `${manifest.creator}:${manifest.namespace}`;
}

/** Extract the discovery `meta` blob from a manifest. */
export function manifestToMeta(manifest: AddonManifest): ManifestMeta {
  const meta: ManifestMeta = { creator: manifest.creator, namespace: manifest.namespace, name: manifest.name };

  if (manifest.creatorName !== undefined) { meta.creatorName = manifest.creatorName; }

  if (manifest.description !== undefined) { meta.description = manifest.description; }

  if (manifest.dependencies !== undefined) { meta.dependencies = manifest.dependencies; }

  if (manifest.optionalDependencies !== undefined) { meta.optionalDependencies = manifest.optionalDependencies; }

  if (manifest.icon !== undefined) { meta.icon = manifest.icon; }

  if (manifest.thumbnail !== undefined) { meta.thumbnail = manifest.thumbnail; }

  return meta;
}

/** Reconstruct a manifest from a peer's transport id + discovery fields + `meta` blob. */
export function manifestFromPeer(
  transportId: string,
  version: string,
  meta: Record<string, unknown> | undefined,
): AddonManifest {
  const namespace = typeof meta?.namespace === 'string' ? meta.namespace : transportId;
  const manifest: AddonManifest = {
    creator: typeof meta?.creator === 'string' ? meta.creator : '',
    namespace,
    name: typeof meta?.name === 'string' ? meta.name : namespace,
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
