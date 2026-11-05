import runtimePackage from '../package.json' with { type: 'json' };

/** The installed runtime package version advertised during discovery and host election. */
export const RUNTIME_VERSION = runtimePackage.version;

/** Authored v3 Minecraft manifest with pack-owned Core identity and integration rules. */
export interface AddonManifest {
  readonly format_version: number;
  readonly namespace: string;
  readonly header: {
    readonly name?: string;
    readonly description?: string;
    readonly uuid?: string;
    readonly version?: string;
    readonly min_engine_version?: string;
    readonly base_game_version?: string;
    readonly pack_optimization_version?: string;
    readonly pack_scope?: string;
    readonly allow_random_seed?: boolean;
    readonly lock_template_options?: boolean;
    readonly platform_locked?: boolean;
  };
  readonly modules: readonly {
    readonly type: string;
    readonly uuid?: string;
    readonly version?: string;
    readonly description?: string;
    readonly language?: string;
    readonly entry?: string;
  }[];
  readonly dependencies?: readonly {
    /** Namespace reference; Builder resolves local pack identities and Core requirements. */
    readonly namespace?: string;
    readonly uuid?: string;
    readonly version?: string;
    /** Minecraft scripting API or installed addon package; Builder resolves its native requirement. */
    readonly module_name?: string;
  }[];
  readonly optionalDependencies?: AddonManifest['dependencies'];
  readonly metadata?: {
    readonly authors?: readonly string[];
    readonly license?: string;
    readonly url?: string;
    readonly product_type?: string;
    readonly generated_with?: Readonly<Record<string, readonly string[]>>;
  };
  readonly capabilities?: readonly string[];
  readonly subpacks?: readonly {
    readonly folder_name: string;
    readonly name: string;
    readonly memory_performance_tier: number;
  }[];
  readonly settings?: readonly {
    readonly type: string;
    readonly text: string;
    readonly name?: string;
    readonly default?: boolean | number | string;
    readonly options?: readonly { readonly name: string; readonly text: string }[];
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
  }[];
  readonly has_education_metadata?: boolean;
  readonly thumbnail?: string;
  readonly extends?: string;
  readonly $schema?: string;
}

const ID_PATTERN = /^[a-z0-9_]+$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`addon manifest '${field}' is required and must be a non-empty string`);
  }

  return value;
}

function namespaceOf(value: unknown, field: string): string {
  const namespace = requireString(value, field);

  if (!ID_PATTERN.test(namespace) || namespace === 'minecraft') {
    throw new Error(`invalid ${field} '${namespace}': use lowercase alphanumeric and underscores; minecraft is reserved`);
  }

  return namespace;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && !!item.trim())) {
    throw new Error(`addon manifest '${field}' must be an array of non-empty strings`);
  }

  return [...value];
}

function dependencies(value: unknown, field: string): AddonManifest['dependencies'] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${field} must contain native dependency objects`);
  }

  return Object.freeze(value.map((dependency: unknown) => {
    if (!record(dependency)) {
      throw new Error(`${field} must contain native dependency objects`);
    }

    if ('pack' in dependency) {
      throw new Error('dependency.pack is not supported; select a local pack by namespace');
    }

    if ('module' in dependency) {
      throw new Error('dependency.module is not supported; use module_name');
    }

    const namespace = dependency.namespace === undefined ? undefined : namespaceOf(dependency.namespace, 'dependency namespace');
    const uuid = dependency.uuid === undefined ? undefined : requireString(dependency.uuid, 'dependency uuid');
    const moduleName = dependency.module_name === undefined ? undefined : requireString(dependency.module_name, 'dependency module_name');

    if ((uuid === undefined) === (moduleName === undefined)) {
      throw new Error(`${field} must resolve to a native uuid or module_name`);
    }

    if (namespace !== undefined && uuid === undefined) {
      throw new Error('addon dependency namespaces require a native pack uuid/version');
    }

    return Object.freeze({
      ...dependency,
      ...(namespace === undefined ? {} : { namespace }),
      ...(uuid === undefined ? {} : { uuid }),
      ...(moduleName === undefined ? {} : { module_name: moduleName }),
      version: requireString(dependency.version, `${field} version`),
    });
  }));
}

/** Validate a resolved authored manifest and preserve its native field structure. */
export function validateManifest(input: unknown): AddonManifest {
  if (!record(input)) {
    throw new TypeError('addon manifest must be an object');
  }

  const namespace = namespaceOf(input.namespace, 'namespace');

  if (!record(input.header)) {
    throw new Error('addon manifest header is required');
  }

  if (input.format_version !== 3) {
    throw new Error('addon manifests require format_version 3');
  }

  if (!Array.isArray(input.modules)) {
    throw new Error('addon manifest needs native modules');
  }

  const header = input.header;
  const name = requireString(header.name, 'header.name');
  const version = requireString(header.version, 'header.version');

  for (const field of ['min_engine_version', 'base_game_version', 'pack_optimization_version']) {
    if (header[field] !== undefined) {
      requireString(header[field], `header.${field}`);
    }
  }

  const description = header.description;

  if (description !== undefined && typeof description !== 'string') {
    throw new Error('addon manifest header.description must be a string');
  }

  if (input.metadata !== undefined && !record(input.metadata)) {
    throw new Error('addon manifest metadata must be an object');
  }

  const metadata = record(input.metadata) ? input.metadata : undefined;
  const authors = metadata?.authors === undefined ? undefined : strings(metadata.authors, 'metadata.authors');
  const required = dependencies(input.dependencies, 'dependencies');
  const optional = dependencies(input.optionalDependencies, 'optionalDependencies');
  const requiredIds = required?.flatMap(dependency => dependency.namespace === undefined ? [] : [dependency.namespace]) ?? [];
  const optionalIds = optional?.flatMap(dependency => dependency.namespace === undefined ? [] : [dependency.namespace]) ?? [];

  if (requiredIds.includes(namespace) || optionalIds.includes(namespace)) {
    throw new Error('an addon cannot depend on its own namespace');
  }

  if (requiredIds.some(id => optionalIds.includes(id))) {
    throw new Error('an addon dependency cannot be both required and optional');
  }

  const modules = input.modules.map((module: unknown) => {
    if (!record(module)) {
      throw new Error('addon manifest modules must contain native module objects');
    }

    return Object.freeze({
      ...module,
      type: requireString(module.type, 'module type'),
      ...(module.version === undefined ? {} : { version: requireString(module.version, 'module version') }),
    });
  });

  Object.freeze(modules);

  const manifest: AddonManifest = {
    ...input,
    format_version: input.format_version,
    namespace,
    header: Object.freeze({ ...header, name, version, ...(description === undefined ? {} : { description }) }),
    modules,
    ...(metadata === undefined ? {} : { metadata: Object.freeze({ ...metadata, ...(authors === undefined ? {} : { authors: Object.freeze(authors) }) }) }),
    ...(required === undefined ? {} : { dependencies: required }),
    ...(optional === undefined ? {} : { optionalDependencies: optional }),
    ...(input.thumbnail === undefined ? {} : { thumbnail: requireString(input.thumbnail, 'thumbnail') }),
  };

  return Object.freeze(manifest);
}

/** Runtime registration version advertised by a peer. */
export function runtimeVersionFromPeer(meta: Record<string, unknown> | undefined): string | undefined {
  return typeof meta?.runtimeVersion === 'string' && meta.runtimeVersion.trim() ? meta.runtimeVersion : undefined;
}
