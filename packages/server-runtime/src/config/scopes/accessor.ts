/**
 * The **accessor tree** — the dotted node tree each config scope hands out, mirroring the
 * schema one-for-one:
 *
 * ```ts
 * config.server.economy.currency.get()          // 'emerald' | 'gold' | 'diamond'
 * config.server.economy.currency.set('gold')
 * config.server.economy.subscribe(economy => { ... })
 * config.player.for(player).notifyOnLogin.get()
 * ```
 *
 * Every node — group or leaf — carries its own verbs, in the style of
 * `world.afterEvents.playerSpawn.subscribe(...)`.
 *
 * The tree is **materialized once, at registration** (see {@link buildAccessorChildren}), not
 * proxied: the schema is static and fully known when `define()` runs, so the walk happens
 * exactly once and every later property access is an ordinary object lookup. In a tick-driven
 * environment that difference is the whole point — a `Proxy` would run a trap on every segment
 * of every read, every tick.
 *
 * Nodes hold no values. Each one closes over its own dot-path and calls back through an
 * {@link AccessorBackend} supplied by the owning scope, which is why the server scope and each
 * entity's tree share one implementation and behave identically.
 */
import type { Unsubscribe } from '@bedrock-core/sync';
import type { ChildKeys, DeepPartial, DotPath, PathValue, SchemaToValue } from '../schema';
import { childEntries, isEntry } from '../schema';
import type { ChangeListener } from './change-emitter';
import type { SchemaTree } from './utils';

// ─── Node types ────────────────────────────────────────────────────────────────

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
 * The verbs a group node carries, the scope root included. `subscribe` keeps the typed
 * dot-path overload as an escape hatch for paths computed at runtime; the path is resolved
 * relative to the node it is called on.
 */
export interface ConfigGroupAccessor<S> {
  get(): SchemaToValue<S>;
  set(value: SchemaToValue<S>): void;
  patch(partial: DeepPartial<SchemaToValue<S>>): void;
  subscribe(listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
  subscribe<P extends DotPath<S>>(path: P, listener: ChangeListener<PathValue<S, P>>): Unsubscribe;
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

/**
 * A whole scope as a tree: the root verbs plus every top-level node. This is what
 * `EntityConfigScope.for(entity)` returns, and what the server scope's own instance is
 * widened to — so both scopes read identically past that point.
 */
export type ConfigTree<S> = ConfigGroupAccessor<S> & ConfigChildren<S>;

// ─── Backend ───────────────────────────────────────────────────────────────────

/**
 * What a materialized tree needs from the scope that owns it. Every call is addressed by flat
 * dot-path, where `''` means the whole scope, so one shape serves the server scope (values
 * keyed by path) and an entity's tree (values keyed by path within that entity).
 */
export interface AccessorBackend {

  /** Effective value at `path`, reconstructed from stored values and schema defaults. */
  read(path: string): unknown;

  /** Deep-merge `value` in at `path`. Only the keys it names change. */
  patch(path: string, value: unknown): void;

  /** Replace the subtree at `path`; schema keys under it that `value` omits revert to their defaults. */
  replace(path: string, value: unknown): void;

  /** Attach a listener to exactly `path`. */
  on(path: string, listener: ChangeListener<unknown>): Unsubscribe;
}

// ─── Materialization ───────────────────────────────────────────────────────────

/**
 * Walk a schema subtree once and build a real object per group and per leaf, each closed over
 * its own dot-path. Returns the children only — the caller decides what carries the verbs for
 * `prefix` itself (the server scope is its own root; `for(entity)` uses
 * {@link buildAccessorNode}).
 */
export function buildAccessorChildren(
  tree: SchemaTree,
  prefix: string,
  backend: AccessorBackend,
): Record<string, unknown> {
  const children: Record<string, unknown> = {};

  for (const [key, node] of childEntries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;

    children[key] = isEntry(node)
      ? leafVerbs(path, backend)
      : { ...groupVerbs(path, backend), ...buildAccessorChildren(node, path, backend) };
  }

  return children;
}

/** A schema subtree as one node: the group verbs at `prefix`, plus its children. */
export function buildAccessorNode(tree: SchemaTree, prefix: string, backend: AccessorBackend): unknown {
  return { ...groupVerbs(prefix, backend), ...buildAccessorChildren(tree, prefix, backend) };
}

/**
 * The shared `subscribe(listener)` / `subscribe(path, listener)` dispatch. A dot-path is
 * resolved relative to `prefix`, so the escape hatch reads the same on the scope root
 * (`subscribe('economy.currency', cb)`) as on a nested group (`economy.subscribe('currency', cb)`).
 */
export function subscribeAt(
  backend: AccessorBackend,
  prefix: string,
  pathOrListener: string | ChangeListener<unknown>,
  listener?: ChangeListener<unknown>,
): Unsubscribe {
  if (typeof pathOrListener === 'function') {
    return backend.on(prefix, pathOrListener);
  }

  if (!listener) { throw new Error('subscribe(path, listener): listener is required'); }

  return backend.on(prefix ? `${prefix}.${pathOrListener}` : pathOrListener, listener);
}

/** A leaf's verbs. `set` is a single-key write — there is no subtree under it to revert. */
function leafVerbs(path: string, backend: AccessorBackend): Record<string, unknown> {
  return {
    get: () => backend.read(path),
    set: (value: unknown): void => { backend.patch(path, value); },
    subscribe: (listener: ChangeListener<unknown>) => backend.on(path, listener),
  };
}

/** A group's verbs, with the same `patch` / `set` semantics the scope root has, scoped to `prefix`. */
function groupVerbs(prefix: string, backend: AccessorBackend): Record<string, unknown> {
  return {
    get: () => backend.read(prefix),
    set: (value: unknown): void => { backend.replace(prefix, value); },
    patch: (partial: unknown): void => { backend.patch(prefix, partial); },
    subscribe: (pathOrListener: string | ChangeListener<unknown>, listener?: ChangeListener<unknown>) =>
      subscribeAt(backend, prefix, pathOrListener, listener),
  };
}
