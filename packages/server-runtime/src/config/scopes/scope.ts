/**
 * A config scope: a db document with the schema walked over it.
 *
 * `collection.for(target)` already reads, writes, patches and notifies for one target, and its
 * `get` / `subscribe` pair is an observable. A scope adds nothing to that but the dotted tree —
 * `config.server.economy.taxRate` is one node closed over the path `['economy', 'taxRate']` into
 * that document, with the same three verbs. The document is nested exactly as the schema is, so a
 * node's `get` is a walk and its `patch` is db's own deep patch.
 *
 * Every node is an observable: `subscribe` is a `computed` over the document, narrowed to the
 * node's own slice and compared structurally, so a leaf fires when its value changes and a group
 * when anything under it does — never for a sibling.
 *
 * The server scope is the tree for the world, built once. The entity scopes hand out a tree per
 * target through `for()`, kept by identity so repeated calls do not rebuild it.
 *
 * Dynamic properties cannot be read before the first tick, and config is declared during
 * registration, before it. Until the registry opens the {@link Gate} a tree answers with the
 * schema's defaults and reads nothing; opening it reads every tree built so far, and db tells the
 * subscribers attached in the meantime what actually loaded.
 */
import { computed, type Unsubscribe } from '@bedrock-core/observable';
import type { Collection, DeepPartial, Document } from '@bedrock-core/db';
import type { ChildKeys, FlatSchema, SchemaGroup, SchemaToValue } from '../schema';
import { childEntries, isEntry } from '../schema';
import { getIn, sameValue, setIn, wrap, type ConfigDocument } from '../document';

// ─── Node types ────────────────────────────────────────────────────────────────

/**
 * A change listener, with the same signature `@bedrock-core/observable`'s `Listener` has. That is
 * what makes a config node an observable structurally, without either package importing the
 * other; pinned by `__type-tests__/leaves-are-observables.ts`.
 *
 * Declared through the "bivariance hack" so a listener typed for a specific value is assignable
 * to the `ChangeListener<unknown>` the tree stores.
 */
export type ChangeListener<V = unknown> = {
  bivarianceHack(next: V, prev: V): void;
}['bivarianceHack'];

/** Structural shape of a schema leaf — the compile-time mirror of the runtime `isEntry` check. */
type LeafEntry = { type: 'boolean' | 'number' | 'string' | 'enum' | 'list' | 'multiselect' };

/**
 * The value type of **one** schema node. Defers to {@link SchemaToValue} by wrapping the node in
 * a single-key schema, so a leaf narrows exactly as it does inside a group — enums to their
 * literal union, `list` to `string[]` — and a group yields its whole nested shape.
 */
export type NodeValue<N> = SchemaToValue<{ node: N }>['node'];

/** A leaf node: read, write and watch one entry. */
export interface ConfigLeafAccessor<N> {
  get(): NodeValue<N>;
  set(value: NodeValue<N>): void;
  subscribe(listener: ChangeListener<NodeValue<N>>): Unsubscribe;
}

/**
 * The verbs a group node carries, the scope root included. `set` replaces the group: a schema
 * key the value omits goes back to its default. `patch` merges, deep.
 */
export interface ConfigGroupAccessor<S> {
  get(): SchemaToValue<S>;
  set(value: SchemaToValue<S>): void;
  patch(partial: DeepPartial<SchemaToValue<S>>): void;
  subscribe(listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
}

/**
 * One accessor node per schema key, keyed exactly as the schema is — minus a group's own
 * `$label`/`$description`, which are strings describing the node rather than nodes of their own.
 */
export type ConfigChildren<S> = { [K in ChildKeys<S>]: ConfigNode<S[K]> };

/**
 * A node of the tree: a leaf accessor, or a group's verbs plus its own children.
 *
 * The group arm tests `Record<string, unknown>` rather than `Record<string, SchemaNode>`: a
 * group that names itself holds `$label: string` alongside its children, which is not a
 * `SchemaNode`, and the stricter test collapsed every such group — and everything under it —
 * to `never`. Anything reaching this arm has already failed the leaf test, so "object" is as
 * precise as the distinction needs to be.
 */
export type ConfigNode<N>
  = N extends LeafEntry ? ConfigLeafAccessor<N>
    : N extends Record<string, unknown> ? ConfigGroupAccessor<N> & ConfigChildren<N>
      : never;

/** A whole scope as a tree: the root verbs plus every top-level node. */
export type ConfigTree<S> = ConfigGroupAccessor<S> & ConfigChildren<S>;

/** A scope root: the tree, plus the flat schema for tooling that enumerates settings. */
export type ScopeTree<S> = ConfigTree<S> & { readonly schema: FlatSchema };

// ─── The tree ──────────────────────────────────────────────────────────────────

/** Whether the world can be read yet. One per registry, opened a tick after registration. */
export interface Gate {
  ready: boolean;
}

/** What every node of one tree shares: the document, the complete defaults, and the gate. */
interface Source {
  readonly document: Document<ConfigDocument>;
  readonly defaults: ConfigDocument;
  readonly gate: Gate;
}

/** The scope's document as read: the stored overrides over the defaults, or the defaults alone. */
function effective(source: Source): ConfigDocument {
  if (!source.gate.ready) { return source.defaults; }

  return source.document.get() ?? source.defaults;
}

function watch(source: Source, path: readonly string[], listener: ChangeListener<unknown>): Unsubscribe {
  const projection = computed(() => getIn(effective(source), path), [source.document], { equals: sameValue });
  const release = projection.subscribe(listener);

  return (): void => {
    release();
    projection.dispose();
  };
}

function leaf(source: Source, path: readonly string[]): Record<string, unknown> {
  return {
    get: (): unknown => getIn(effective(source), path),
    set: (value: unknown): void => { source.document.patch(wrap(path, value)); },
    subscribe: (listener: ChangeListener<unknown>): Unsubscribe => watch(source, path, listener),
  };
}

function group(source: Source, tree: SchemaGroup, path: readonly string[]): Record<string, unknown> {
  const node: Record<string, unknown> = {
    get: (): unknown => getIn(effective(source), path),
    // Everything the new value omits under this path is gone from the document, so it reads as
    // its default; the schema's `normalize` keeps what is at a default out of the bytes.
    set: (value: unknown): void => { source.document.set(setIn(source.document.get(), path, value)); },
    patch: (partial: unknown): void => { source.document.patch(wrap(path, partial)); },
    subscribe: (listener: ChangeListener<unknown>): Unsubscribe => watch(source, path, listener),
  };

  for (const [key, child] of childEntries(tree)) {
    node[key] = isEntry(child) ? leaf(source, [...path, key]) : group(source, child, [...path, key]);
  }

  return node;
}

function treeFor<S extends Record<string, unknown>>(
  document: Document<ConfigDocument>,
  tree: SchemaGroup,
  defaults: ConfigDocument,
  flatSchema: FlatSchema,
  gate: Gate,
): ScopeTree<S> {
  // TypeScript cannot see the properties a schema walk produces, which is what this states.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return { schema: flatSchema, ...group({ document, defaults, gate }, tree, []) } as ScopeTree<S>;
}

/** The scope for a single fixed target — the world. */
export function serverScope<S extends Record<string, unknown>, Target>(
  collection: Collection<ConfigDocument, Target>,
  target: Target,
  tree: SchemaGroup,
  defaults: ConfigDocument,
  flatSchema: FlatSchema,
  gate: Gate,
): ScopeTree<S> {
  return treeFor<S>(collection.for(target), tree, defaults, flatSchema, gate);
}

/**
 * A scope over many targets of one kind — dimensions, players.
 *
 * `for()` keeps the tree by the target's own identity: db already routes a document's change
 * events by identity, so this is only to avoid rebuilding the closures on every call.
 */
export class EntityScope<S extends Record<string, unknown>, Target> {
  private readonly _collection: Collection<ConfigDocument, Target>;
  private readonly _tree: SchemaGroup;
  private readonly _defaults: ConfigDocument;
  private readonly _gate: Gate;
  private readonly _trees = new Map<string, ScopeTree<S>>();

  readonly schema: FlatSchema;

  constructor(collection: Collection<ConfigDocument, Target>, tree: SchemaGroup, defaults: ConfigDocument, flatSchema: FlatSchema, gate: Gate) {
    this._collection = collection;
    this._tree = tree;
    this._defaults = defaults;
    this.schema = flatSchema;
    this._gate = gate;
  }

  for(target: Target): ScopeTree<S> {
    const id = identityOf(target);
    let tree = this._trees.get(id);

    if (tree === undefined) {
      tree = treeFor<S>(this._collection.for(target), this._tree, this._defaults, this.schema, this._gate);
      this._trees.set(id, tree);
    }

    return tree;
  }

  /** @internal Read every tree handed out so far, so their subscribers learn what is stored. Called once the gate opens. */
  warm(): void {
    for (const tree of this._trees.values()) { tree.get(); }
  }

  /** Drop what this scope remembers about a target. Its document stays where it is. */
  forget(target: Target): void {
    this._trees.delete(identityOf(target));
  }

  /** The same, for a target that has already left and is only an id now. */
  forgetId(identity: string): void {
    this._trees.delete(identity);
  }

  /** The whole value for one target — {@link LocalConfigScopes} for tooling without the schema's type. */
  get(target: Target): unknown {
    return this.for(target).get();
  }

  /** Merge a nested partial into one target — {@link LocalConfigScopes} for tooling without the schema's type. */
  patch(target: Target, partial: Record<string, unknown>): void {
    // The tree's `patch` is typed against the schema; tooling has only a record.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    this.for(target).patch(partial as DeepPartial<SchemaToValue<S>>);
  }
}

/** An entity's id, a dimension's id — whatever names the target for the tree cache. */
function identityOf(target: unknown): string {
  if (typeof target === 'object' && target !== null && 'id' in target) {
    const { id } = target;

    if (typeof id === 'string') { return id; }
  }

  return String(target);
}
