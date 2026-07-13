/**
 * Config schema types and compile-time inference helpers.
 *
 * `type` is a reserved key — do not use it as a group name.
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

export type ConfigEntry = BooleanEntry | NumberEntry | StringEntry | EnumEntry | ListEntry;

// ─── Schema node types ─────────────────────────────────────────────────────────

export type SchemaNode = ConfigEntry | SchemaGroup;
export type SchemaGroup = { [key: string]: SchemaNode };

export type ServerScopeSchema = { [key: string]: SchemaNode };
export type DimensionScopeSchema = { [key: string]: SchemaNode };
export type PlayerScopeSchema = { [key: string]: SchemaNode };

export interface ConfigDefinition {
  server?: ServerScopeSchema;
  dimension?: DimensionScopeSchema;
  player?: PlayerScopeSchema;
}

// ─── Structured value inference ────────────────────────────────────────────────

/** Convert a schema tree into its runtime value shape (nested object). */
export type SchemaToValue<S> = {
  [K in keyof S & string]: S[K] extends { type: 'boolean' } ? boolean
    : S[K] extends { type: 'number' } ? number
      : S[K] extends { type: 'string' } ? string
        : S[K] extends { type: 'enum'; options: readonly (infer O)[] } ? O
          : S[K] extends { type: 'list' } ? string[]
            : S[K] extends Record<string, SchemaNode> ? SchemaToValue<S[K]>
              : never
};

/** All valid subscribe paths in S — includes both leaf keys and group keys. */
export type DotPath<S> = keyof S & string | {
  [K in keyof S & string]: S[K] extends { type: string } ? never
    : S[K] extends Record<string, SchemaNode> ? `${K}.${DotPath<S[K]>}`
      : never
}[keyof S & string];

/** Value type at dot-path P within schema S. Works for both leaves and groups. */
export type PathValue<S, P extends string>
  = P extends keyof S & string
    ? S[P] extends { type: 'boolean' } ? boolean
      : S[P] extends { type: 'number' } ? number
        : S[P] extends { type: 'string' } ? string
          : S[P] extends { type: 'enum'; options: readonly (infer O)[] } ? O
            : S[P] extends { type: 'list' } ? string[]
              : S[P] extends Record<string, SchemaNode> ? SchemaToValue<S[P]>
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
  [K in keyof T & string]: T[K] extends { type: 'boolean' | 'number' | 'string' | 'enum' | 'list' }
    ? (P extends '' ? K : `${P}.${K}`)
    : T[K] extends object
      ? FlatKeys<T[K], P extends '' ? K : `${P}.${K}`>
      : never
}[keyof T & string];

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
    | { type: 'list'; itemType: 'string' | 'enum'; options?: readonly string[]; maxItems?: number; default: string; label: string; description?: string };

export type FlatSchema = Record<string, SerializedEntry>;

export function flattenSchema(schema: Record<string, SchemaNode>, prefix = ''): FlatSchema {
  const result: FlatSchema = {};

  for (const [key, node] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isEntry(node)) {
      result[path] = serializeEntry(node);
    } else {
      Object.assign(result, flattenSchema(node, path));
    }
  }

  return result;
}

export function isEntry(node: unknown): node is ConfigEntry {
  if (typeof node !== 'object' || node === null) { return false; }

  const t = (node as { type?: unknown }).type;

  return t === 'boolean' || t === 'number' || t === 'string' || t === 'enum' || t === 'list';
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
  }
}
