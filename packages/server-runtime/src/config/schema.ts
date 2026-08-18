/**
 * Config schema types and compile-time inference helpers.
 *
 * `type` is a reserved key — do not use it as a group name. So are the accessor tree's own
 * verbs, at any depth — see {@link RESERVED_KEYS} and {@link validateConfigSchema}.
 */

// ─── Value type ────────────────────────────────────────────────────────────────

export type ConfigValue = boolean | number | string;

// ─── Entry definitions ─────────────────────────────────────────────────────────

export type BooleanEntry = {
  type: 'boolean';
  default: boolean;
  label: string;
  description?: string;
};

export type NumberEntry = {
  type: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  description?: string;
};

export type StringEntry = {
  type: 'string';
  default: string;
  maxLength?: number;
  label: string;
  description?: string;
};

export type EnumEntry<O extends readonly string[] = readonly string[]> = {
  type: 'enum';
  default: O[number];
  options: O;
  label: string;
  description?: string;
};

export type ListEntry = {
  type: 'list';
  itemType: 'string' | 'enum';
  options?: readonly string[];
  maxItems?: number;
  default: readonly string[];
  label: string;
  description?: string;
};

/**
 * Any number of a fixed option set — a checkbox group.
 *
 * Distinct from {@link ListEntry}, which is an open-ended collection an addon can only cap:
 * a multiselect's whole option set is known at declaration, so every choice fits on screen and
 * the modal can draw it as one checkbox per option. A list cannot, which is why it has no native
 * control at all and gets a screen of its own instead.
 */
export type MultiselectEntry = {
  type: 'multiselect';
  options: readonly string[];
  default: readonly string[];
  label: string;
  description?: string;
};

export type ConfigEntry = BooleanEntry | NumberEntry | StringEntry | EnumEntry | ListEntry | MultiselectEntry;

// ─── Schema node types ─────────────────────────────────────────────────────────

export type SchemaNode = ConfigEntry | SchemaGroup;

/**
 * A group's own display strings, declared alongside its children.
 *
 * The `$` sigil is what keeps them out of the child namespace: a group is otherwise an open
 * record of `SchemaNode`, so any bare name we reserved (`label`, `meta`) would be a name an
 * addon could plausibly want for a setting. `$` cannot start a schema key — `validateConfigSchema`
 * rejects it — so the two spaces never meet.
 */
export type GroupMeta = {
  $label?: string;
  $description?: string;
};

export type SchemaGroup = GroupMeta & { [key: string]: SchemaNode | string | undefined };

export type ServerScopeSchema = { [key: string]: SchemaNode };
export type DimensionScopeSchema = { [key: string]: SchemaNode };
export type PlayerScopeSchema = { [key: string]: SchemaNode };

export interface ConfigDefinition {
  server?: ServerScopeSchema;
  dimension?: DimensionScopeSchema;
  player?: PlayerScopeSchema;
}

// ─── Structured value inference ────────────────────────────────────────────────

/**
 * The child keys of a schema group — everything except the group's own `$label`/`$description`.
 *
 * Every inference helper below walks this rather than `keyof S`, so a group that names itself
 * does not grow a phantom `$label: string` in its value object or a `$label` dot-path.
 *
 * Those helpers also test a group with `Record<string, unknown>` rather than
 * `Record<string, SchemaNode>`: a named group holds `$label: string` beside its children, which
 * is not a `SchemaNode`, and the stricter test collapsed the whole group — and everything under
 * it — to `never`. The leaf arms are tested first, so "object" is as precise as it needs to be.
 */
export type ChildKeys<S> = Exclude<keyof S & string, `$${string}`>;

/** Convert a schema tree into its runtime value shape (nested object). */
export type SchemaToValue<S> = {
  [K in ChildKeys<S>]: S[K] extends { type: 'boolean' } ? boolean
    : S[K] extends { type: 'number' } ? number
      : S[K] extends { type: 'string' } ? string
        : S[K] extends { type: 'enum'; options: readonly (infer O)[] } ? O
          : S[K] extends { type: 'list' | 'multiselect' } ? string[]
            : S[K] extends Record<string, unknown> ? SchemaToValue<S[K]>
              : never
};

/** All valid subscribe paths in S — includes both leaf keys and group keys. */
export type DotPath<S> = ChildKeys<S> | {
  [K in ChildKeys<S>]: S[K] extends { type: string } ? never
    : S[K] extends Record<string, unknown> ? `${K}.${DotPath<S[K]>}`
      : never
}[ChildKeys<S>];

/** Value type at dot-path P within schema S. Works for both leaves and groups. */
export type PathValue<S, P extends string>
  = P extends keyof S & string
    ? S[P] extends { type: 'boolean' } ? boolean
      : S[P] extends { type: 'number' } ? number
        : S[P] extends { type: 'string' } ? string
          : S[P] extends { type: 'enum'; options: readonly (infer O)[] } ? O
            : S[P] extends { type: 'list' | 'multiselect' } ? string[]
              : S[P] extends Record<string, unknown> ? SchemaToValue<S[P]>
                : never
    : P extends `${infer Head}.${infer Tail}`
      ? Head extends keyof S & string
        ? PathValue<S[Head], Tail>
        : never
      : never;

/** Recursively-partial version of a schema value type — used for patch inputs. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K]
};

// ─── Internal flat-key inference (used by DP key generation) ──────────────────

export type FlatKeys<T, P extends string = ''> = {
  [K in ChildKeys<T>]: T[K] extends { type: 'boolean' | 'number' | 'string' | 'enum' | 'list' | 'multiselect' }
    ? (P extends '' ? K : `${P}.${K}`)
    : T[K] extends object
      ? FlatKeys<T[K], P extends '' ? K : `${P}.${K}`>
      : never
}[ChildKeys<T>];

export type FlatValue<T, K extends string>
  = K extends keyof T & string
    ? T[K] extends { type: 'boolean' } ? boolean
      : T[K] extends { type: 'number' } ? number
        : T[K] extends { type: 'string' } ? string
          : T[K] extends { type: 'enum'; options: readonly (infer O)[] } ? O
            : never
    : K extends `${infer Head}.${infer Tail}`
      ? Head extends keyof T & string ? FlatValue<T[Head], Tail> : never
      : never;

// ─── Serialized form (broadcast) ──────────────────────────────────────────────

export type SerializedEntry
  = | { type: 'boolean'; default: boolean; label: string; description?: string }
    | { type: 'number'; default: number; min: number; max: number; step?: number; label: string; description?: string }
    | { type: 'string'; default: string; maxLength?: number; label: string; description?: string }
    | { type: 'enum'; default: string; options: readonly string[]; label: string; description?: string }
    | { type: 'list'; itemType: 'string' | 'enum'; options?: readonly string[]; maxItems?: number; default: string; label: string; description?: string }
    | { type: 'multiselect'; options: readonly string[]; default: string; label: string; description?: string };

export type FlatSchema = Record<string, SerializedEntry>;

/** One group's display strings as they travel, keyed by the group's dot-path. */
export type SerializedGroup = { label?: string; description?: string };

/** Group metadata, dot-path → strings. Groups that declare none are absent, not empty. */
export type FlatGroups = Record<string, SerializedGroup>;

// ─── Reserved keys ─────────────────────────────────────────────────────────────

/**
 * The verbs the accessor tree hangs on **every** node (`config.server.economy.currency.get()`),
 * plus `for`, which the entity scopes use to select an entity. A schema key with one of these
 * names would shadow the method on its own node, so none of them may be used at any depth.
 */
export const RESERVED_KEYS = ['get', 'set', 'patch', 'subscribe', 'for'] as const;

const RESERVED = new Set<string>(RESERVED_KEYS);

/**
 * Reject schema keys that collide with the accessor tree's own verbs. Runs at registration,
 * before anything is materialized, so a bad schema fails at the declaration instead of
 * silently shadowing `get` or `subscribe` somewhere deep in a tree — a failure that would
 * otherwise surface as a `TypeError` at some unrelated call site much later.
 *
 * `scope` leads the reported path (`server.economy.set`) so the error points straight at the
 * declaration, matching how the schema is addressed everywhere else it is published.
 */
export function validateConfigSchema(scope: string, schema: SchemaGroup, prefix = ''): void {
  for (const [key, node] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;

    // A group's own display strings, not a child. They are strings rather than nodes, so they
    // are checked here and skipped rather than walked into.
    if (isGroupMetaKey(key)) {
      if (!GROUP_META_KEYS.has(key)) {
        throw new Error(
          `config schema: "${scope}.${path}" is not a group property; $-prefixed keys are ${[...GROUP_META_KEYS].join(', ')}`,
        );
      }

      if (node !== undefined && typeof node !== 'string') {
        throw new Error(`config schema: "${scope}.${path}" must be a string`);
      }

      continue;
    }

    if (RESERVED.has(key)) {
      throw new Error(
        `config schema: "${scope}.${path}" uses the reserved key "${key}"; reserved keys are ${RESERVED_KEYS.join(', ')}`,
      );
    }

    if (typeof node !== 'object' || node === null) {
      throw new Error(`config schema: "${scope}.${path}" is neither an entry nor a group`);
    }

    if (!isEntry(node)) { validateConfigSchema(scope, node, path); }
  }
}

/** The group display keys, and the sigil test that keeps them out of the child namespace. */
const GROUP_META_KEYS = new Set<string>(['$label', '$description']);

export function isGroupMetaKey(key: string): boolean {
  return key.startsWith('$');
}

/**
 * A group's children — its `$`-prefixed display strings dropped, and the rest narrowed back to
 * `SchemaNode`.
 *
 * Every walk over a schema tree goes through this. The alternative was for each of them to
 * re-derive the same skip, and a walker that forgot would grow a phantom `$label` node in the
 * accessor tree or a phantom `$label` key in a value object — a defect that only shows up at the
 * far end, in the shape a caller reads back.
 */
export function childEntries(group: SchemaGroup): [string, SchemaNode][] {
  const out: [string, SchemaNode][] = [];

  for (const [key, node] of Object.entries(group)) {
    if (isGroupMetaKey(key) || typeof node !== 'object' || node === null) { continue; }

    out.push([key, node]);
  }

  return out;
}

/** A group's child node by key, or `undefined` for a missing key or a `$` display string. */
export function childNode(group: SchemaGroup, key: string): SchemaNode | undefined {
  if (isGroupMetaKey(key)) { return undefined; }

  const node = group[key];

  // The index signature already says `SchemaNode | string | undefined`, so ruling out the two
  // non-node cases IS the narrowing — no assertion needed.
  return typeof node === 'object' && node !== null ? node : undefined;
}

export function flattenSchema(schema: SchemaGroup, prefix = ''): FlatSchema {
  const result: FlatSchema = {};

  for (const [key, node] of childEntries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isEntry(node)) {
      result[path] = serializeEntry(node);
    } else {
      Object.assign(result, flattenSchema(node, path));
    }
  }

  return result;
}

/**
 * The group half of {@link flattenSchema}: every group that declares a display string, keyed by
 * the same dot-path its children are keyed under.
 *
 * Kept separate from the entry map rather than folded in as a pseudo-entry, because the two are
 * read by different things — `buildNestedObject` and the accessor tree walk entries and would
 * have to learn to skip a node that is not a value. A group with nothing to say is omitted
 * entirely, so a schema that declares no metadata flattens to `{}` and costs nothing on the wire.
 */
export function flattenGroups(schema: SchemaGroup, prefix = ''): FlatGroups {
  const result: FlatGroups = {};
  const label = schema.$label;
  const description = schema.$description;

  if (prefix !== '' && (typeof label === 'string' || typeof description === 'string')) {
    result[prefix] = {
      ...(typeof label === 'string' ? { label } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    };
  }

  for (const [key, node] of childEntries(schema)) {
    if (isEntry(node)) { continue; }

    const path = prefix ? `${prefix}.${key}` : key;

    Object.assign(result, flattenGroups(node, path));
  }

  return result;
}

export function isEntry(node: unknown): node is ConfigEntry {
  if (typeof node !== 'object' || node === null) { return false; }

  const t = (node as { type?: unknown }).type;

  return t === 'boolean' || t === 'number' || t === 'string' || t === 'enum' || t === 'list' || t === 'multiselect';
}

function serializeEntry(entry: ConfigEntry): SerializedEntry {
  const common = {
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
  };

  switch (entry.type) {
    case 'boolean':
      return {
        type: 'boolean',
        default: entry.default,
        ...common,
      };
    case 'number':
      return {
        type: 'number',
        default: entry.default,
        min: entry.min,
        max: entry.max,
        ...(entry.step !== undefined ? { step: entry.step } : {}),
        ...common,
      };
    case 'string':
      return {
        type: 'string',
        default: entry.default,
        ...(entry.maxLength !== undefined ? { maxLength: entry.maxLength } : {}),
        ...common,
      };
    case 'enum':
      return {
        type: 'enum',
        default: entry.default,
        options: entry.options,
        ...common,
      };
    case 'list':
      // Store the default as a JSON string — list values travel as serialized arrays.
      return {
        type: 'list',
        itemType: entry.itemType,
        default: JSON.stringify(entry.default),
        ...(entry.options ? { options: entry.options } : {}),
        ...(entry.maxItems !== undefined ? { maxItems: entry.maxItems } : {}),
        ...common,
      };
    case 'multiselect':
      // Same JSON-string storage as a list: the value is an array, and a stored value is one
      // of `ConfigValue`'s three scalars.
      return {
        type: 'multiselect',
        options: entry.options,
        default: JSON.stringify(entry.default),
        ...common,
      };
  }
}
