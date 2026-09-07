/**
 * The shared tree: a `shared` declaration materialized once into nodes, every node carrying
 * `get` / `subscribe`, own leaves and branches also `set` / `patch`. Nested keys flatten to dotted
 * mirror keys (`event.active`); the tree is the typed view over them, and each leaf is a
 * `ReadonlyObservable` in the `@bedrock-core/observable` sense — `computed`, `effect`,
 * `useObservable` and `toNative` take it as it is.
 *
 * Nothing here knows the engine or the transport: a tree talks to a {@link SharedBackend}, which
 * the registry implements over sync's `State`. That is what lets the tree be tested in vitest and
 * lets the same code build a peer's read-only tree from an announced shape.
 */
import type { Unsubscribe } from '@bedrock-core/sync';
import { isMarked, type Marked, type Unmarked } from './markers';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A declaration: values are leaves, plain objects are branches, markers wrap either. */
export type SharedDef = Readonly<Record<string, unknown>>;

type IsPlain<V> = V extends readonly unknown[] ? false : V extends (...args: never[]) => unknown ? false : V extends object ? true : false;

type IsBranch<N> = N extends Marked<infer V, infer L, boolean> ? (L extends true ? false : IsPlain<V>) : IsPlain<N>;

type IsOpen<N> = N extends Marked<unknown, boolean, infer O> ? O : false;

/** The runtime value a node holds: a leaf's value, or a branch's leaves as a nested object. */
export type SharedValue<N> = IsBranch<N> extends true
  ? { -readonly [K in keyof Unmarked<N>]: SharedValue<Unmarked<N>[K]> }
  : Unmarked<N>;

export type Listener<T> = (value: T) => void;

export interface SharedLeaf<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: Listener<T>): Unsubscribe;
}

export interface SharedBranch<V> {
  get(): V;
  set(value: V): void;
  /** Writes only the leaves present in `changes`, at any depth. */
  patch(changes: DeepPartial<V>): void;
  /** Fires with the whole branch when any leaf under it changes. */
  subscribe(listener: Listener<V>): Unsubscribe;
}

export type DeepPartial<V> = V extends readonly unknown[] ? V : V extends object ? { [K in keyof V]?: DeepPartial<V[K]> } : V;

export type SharedNode<N> = IsBranch<N> extends true
  ? SharedBranch<SharedValue<N>> & { readonly [K in keyof Unmarked<N>]: SharedNode<Unmarked<N>[K]> }
  : SharedLeaf<SharedValue<N>>;

/** The owner's tree: the declaration, typed. */
export type SharedTree<Def extends SharedDef> = SharedBranch<SharedValue<Def>> & { readonly [K in keyof Def]: SharedNode<Def[K]> };

/** A peer's value can lag its shape: a leaf the mirror has not received yet reads `undefined`. */
export type PeerValue<N> = IsBranch<N> extends true
  ? { -readonly [K in keyof Unmarked<N>]: PeerValue<Unmarked<N>[K]> }
  : Unmarked<N> | undefined;

export interface PeerLeaf<T> {
  get(): T | undefined;
  subscribe(listener: Listener<T | undefined>): Unsubscribe;
}

export interface OpenPeerLeaf<T> extends PeerLeaf<T> {
  /** The owner opened this leaf: any realm may write it. */
  set(value: T): void;
}

export interface PeerBranch<V> {
  get(): V;
  subscribe(listener: Listener<V>): Unsubscribe;
}

export type PeerNode<N> = IsBranch<N> extends true
  ? PeerBranch<PeerValue<N>> & { readonly [K in keyof Unmarked<N>]: PeerNode<Unmarked<N>[K]> }
  : IsOpen<N> extends true ? OpenPeerLeaf<Unmarked<N>> : PeerLeaf<Unmarked<N>>;

/** A peer's tree: read-only except where the owner said otherwise. */
export type PeerSharedTree<Def extends SharedDef> = PeerBranch<PeerValue<Def>> & { readonly [K in keyof Def]: PeerNode<Def[K]> };

// ─── The compiled declaration ──────────────────────────────────────────────────

export interface LeafSpec {
  /** The dotted mirror key. */
  readonly path: string;
  readonly initial: unknown;
  readonly open: boolean;
  readonly persisted: boolean;
}

/** What the owner announces: every leaf path, and which are open. Values never travel here. */
export type Shape = Readonly<Record<string, { readonly o?: true }>>;

/** Names a branch cannot give a child, because the branch itself answers to them. */
export const RESERVED_SHARED_KEYS: readonly string[] = ['get', 'set', 'patch', 'subscribe'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Walk a declaration into leaf specs; markers on a branch are inherited by everything under it. */
export function compileShared(def: SharedDef): LeafSpec[] {
  const leaves: LeafSpec[] = [];

  const walk = (node: unknown, path: string, open: boolean, persisted: boolean): void => {
    let value = node;
    let forcedLeaf = false;

    if (isMarked(node)) {
      value = node.value;
      forcedLeaf = node.leaf;
      open = open || node.open;
      persisted = persisted || node.persisted;
    }

    if (!forcedLeaf && isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        if (RESERVED_SHARED_KEYS.includes(key)) {
          throw new Error(`[shared] '${path === '' ? key : `${path}.${key}`}' is reserved — a branch answers to ${RESERVED_SHARED_KEYS.join(', ')}`);
        }

        if (key.includes('.')) {
          throw new Error(`[shared] '${key}' cannot contain a dot: dots separate the mirror key`);
        }

        walk(value[key], path === '' ? key : `${path}.${key}`, open, persisted);
      }

      return;
    }

    if (path === '') {
      throw new Error('[shared] the declaration itself must be an object of keys');
    }

    leaves.push({ path, initial: value, open, persisted });
  };

  walk(def, '', false, false);

  return leaves;
}

export function shapeOf(leaves: readonly LeafSpec[]): Shape {
  const shape: Record<string, { o?: true }> = {};

  for (const spec of leaves) {
    shape[spec.path] = spec.open ? { o: true } : {};
  }

  return shape;
}

export function leavesOfShape(shape: Shape): LeafSpec[] {
  return Object.keys(shape).map(path => ({ path, initial: undefined, open: shape[path]?.o === true, persisted: false }));
}

// ─── The backend ───────────────────────────────────────────────────────────────

/** What a tree needs from the mirror. Keys are the dotted leaf paths. */
export interface SharedBackend {
  read(path: string): unknown;
  /** Throws when this realm may not write the key. */
  write(path: string, value: unknown, spec: LeafSpec): void;
  /** Every change to a key of this namespace, local or remote. */
  onChange(listener: (path: string, value: unknown) => void): Unsubscribe;
}

// ─── Materialization ───────────────────────────────────────────────────────────

interface Dispatcher {
  on(path: string, listener: (path: string, value: unknown) => void): Unsubscribe;
}

/** One backend subscription per tree, attached on the first subscriber and released on the last. */
function createDispatcher(backend: SharedBackend): Dispatcher {
  const listeners = new Map<string, Set<(path: string, value: unknown) => void>>();
  let release: Unsubscribe | undefined;
  let count = 0;

  const dispatch = (path: string, value: unknown): void => {
    for (const [prefix, set] of listeners) {
      if (prefix === '' || path === prefix || path.startsWith(`${prefix}.`)) {
        for (const listener of [...set]) {
          listener(path, value);
        }
      }
    }
  };

  return {
    on: (path, listener): Unsubscribe => {
      let set = listeners.get(path);

      if (set === undefined) {
        set = new Set();
        listeners.set(path, set);
      }

      set.add(listener);
      count++;
      release ??= backend.onChange(dispatch);

      let released = false;

      return (): void => {
        if (released) {
          return;
        }

        released = true;
        set.delete(listener);

        if (set.size === 0) {
          listeners.delete(path);
        }

        if (--count === 0 && release !== undefined) {
          release();
          release = undefined;
        }
      };
    },
  };
}

class LeafNode {
  constructor(
    private readonly _backend: SharedBackend,
    private readonly _dispatcher: Dispatcher,
    private readonly _spec: LeafSpec,
    private readonly _fallback: boolean,
  ) {}

  get(): unknown {
    const value = this._backend.read(this._spec.path);

    return value === undefined && this._fallback ? this._spec.initial : value;
  }

  set(value: unknown): void {
    this._backend.write(this._spec.path, value, this._spec);
  }

  subscribe(listener: Listener<unknown>): Unsubscribe {
    return this._dispatcher.on(this._spec.path, (_path, value) => {
      listener(value === undefined && this._fallback ? this._spec.initial : value);
    });
  }
}

class BranchNode {
  constructor(
    private readonly _backend: SharedBackend,
    private readonly _dispatcher: Dispatcher,
    private readonly _path: string,
    private readonly _leaves: readonly LeafSpec[],
    private readonly _fallback: boolean,
  ) {}

  get(): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    const from = this._path === '' ? 0 : this._path.length + 1;

    for (const spec of this._leaves) {
      const read = this._backend.read(spec.path);

      setAtPath(value, spec.path.slice(from), read === undefined && this._fallback ? spec.initial : read);
    }

    return value;
  }

  set(value: unknown): void {
    this._writeFrom(value, true);
  }

  patch(changes: unknown): void {
    this._writeFrom(changes, false);
  }

  subscribe(listener: Listener<Record<string, unknown>>): Unsubscribe {
    return this._dispatcher.on(this._path, () => {
      listener(this.get());
    });
  }

  /** Writes each leaf under this branch from a nested value; a leaf absent from the value is skipped on patch, written as `undefined` on set. */
  private _writeFrom(value: unknown, whole: boolean): void {
    const from = this._path === '' ? 0 : this._path.length + 1;

    for (const spec of this._leaves) {
      const found = valueAtPath(value, spec.path.slice(from));

      if (found.present || whole) {
        this._backend.write(spec.path, found.value, spec);
      }
    }
  }
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? '';
    const next = cursor[part];

    if (isPlainObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};

      cursor[part] = created;
      cursor = created;
    }
  }

  cursor[parts[parts.length - 1] ?? ''] = value;
}

function valueAtPath(source: unknown, path: string): { present: boolean; value: unknown } {
  let cursor: unknown = source;

  for (const part of path.split('.')) {
    if (!isPlainObject(cursor) || !(part in cursor)) {
      return { present: false, value: undefined };
    }

    cursor = cursor[part];
  }

  return { present: cursor !== undefined, value: cursor };
}

/**
 * Build the node tree for a set of leaves. `fallback` makes a leaf read its declared initial value
 * while the mirror has none — the owner's tree before its first write lands; a peer's tree reads
 * `undefined` there instead, since it never knows the initial values.
 */
export function materialize(backend: SharedBackend, leaves: readonly LeafSpec[], fallback: boolean): Record<string, unknown> {
  const dispatcher = createDispatcher(backend);

  const build = (path: string): unknown => {
    const under = path === '' ? leaves : leaves.filter(spec => spec.path === path || spec.path.startsWith(`${path}.`));
    const exact = under.find(spec => spec.path === path);

    if (exact !== undefined) {
      return new LeafNode(backend, dispatcher, exact, fallback);
    }

    const node: Record<string, unknown> = Object.create(new BranchNode(backend, dispatcher, path, under, fallback)) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    const from = path === '' ? 0 : path.length + 1;
    const childNames = new Set(under.map(spec => spec.path.slice(from).split('.')[0] ?? ''));

    for (const name of childNames) {
      node[name] = build(path === '' ? name : `${path}.${name}`);
    }

    return node;
  };

  return build('') as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}
