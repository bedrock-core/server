/**
 * The shared tree: one node per declared key, each an observable over the mirror.
 *
 * A declaration is a flat record — every top-level key is one value, an object included, written
 * and replicated whole. There is no nesting, no dotted key, no branch: a shape that wants
 * structure puts an object in one key and pays for it on every write, which is the honest cost
 * (publishing serializes on the owner's tick).
 *
 * A node's `get` / `subscribe` pair is `@bedrock-core/observable`'s `ReadonlyObservable`, so a
 * shared value can be `computed` over or handed to a UI hook exactly like a config leaf or a db
 * document. The owner's nodes also have `set`; a peer's never do — a peer that wants a change asks
 * the owner over rpc.
 *
 * Nothing here knows the engine or the transport: a tree talks to a {@link SharedBackend}, which
 * the registry implements over sync's `State`. That is what lets the tree be tested in vitest and
 * lets the same code build a peer's read-only tree from an announced shape.
 */
import type { Unsubscribe } from '@bedrock-core/sync';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A declaration: a flat record of keys to their initial values. */
export type SharedDef = Readonly<Record<string, unknown>>;

/** The observable listener signature: the new value and the one before it. */
export type Listener<T> = (next: T, prev: T) => void;

/** The owner's view of one key. */
export interface SharedValue<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: Listener<T>): Unsubscribe;
}

/** A peer's view of one key: readable, and `undefined` until the owner's value has arrived. */
export interface PeerValue<T> {
  get(): T | undefined;
  subscribe(listener: Listener<T | undefined>): Unsubscribe;
}

/** The owner's tree: the declaration, typed. */
export type SharedTree<Def extends SharedDef> = { readonly [K in keyof Def]: SharedValue<Def[K]> };

/** A peer's tree: the same keys, read-only. */
export type PeerSharedTree<Def extends SharedDef> = { readonly [K in keyof Def]: PeerValue<Def[K]> };

/** What the owner announces: its key names. Values travel as themselves, never here. */
export type Shape = readonly string[];

export function isShape(value: unknown): value is Shape {
  return Array.isArray(value) && value.every(key => typeof key === 'string');
}

// ─── The backend ───────────────────────────────────────────────────────────────

/** What a tree needs from the mirror. */
export interface SharedBackend {
  read(key: string): unknown;
  /** Only an owner's backend has one; a peer's tree never writes. */
  write?(key: string, value: unknown): void;
  /** Called whenever `key` changes in this namespace, local or remote. */
  onChange(key: string, listener: () => void): Unsubscribe;
}

// ─── The node ──────────────────────────────────────────────────────────────────

/**
 * One key, as an observable.
 *
 * The mirror is the value: `get` reads it every time rather than caching, so a node is always
 * right even before anything has subscribed. The backend subscription is attached with the first
 * listener and released with the last, so a tree nobody watches costs nothing per change.
 */
class Node {
  private readonly _listeners = new Set<Listener<unknown>>();
  private _release: Unsubscribe | undefined;
  private _prev: unknown;

  constructor(
    private readonly _backend: SharedBackend,
    private readonly _key: string,
    private readonly _initial: unknown,
    private readonly _hasInitial: boolean,
  ) {}

  get(): unknown {
    const value = this._backend.read(this._key);

    return value === undefined && this._hasInitial ? this._initial : value;
  }

  set(value: unknown): void {
    const write = this._backend.write;

    if (write === undefined) {
      throw new Error(`[shared] '${this._key}' belongs to another addon: only its owner may write it`);
    }

    write.call(this._backend, this._key, value);
  }

  subscribe(listener: Listener<unknown>): Unsubscribe {
    if (this._listeners.size === 0) {
      this._prev = this.get();
      this._release = this._backend.onChange(this._key, () => { this._fire(); });
    }

    this._listeners.add(listener);

    let released = false;

    return (): void => {
      if (released) { return; }

      released = true;
      this._listeners.delete(listener);

      if (this._listeners.size === 0 && this._release !== undefined) {
        this._release();
        this._release = undefined;
      }
    };
  }

  /** One listener that throws must not stop the others, and must not escape into the engine. */
  private _fire(): void {
    const next = this.get();
    const prev = this._prev;

    this._prev = next;

    for (const listener of [...this._listeners]) {
      try {
        listener(next, prev);
      } catch (error) {
        console.warn(`[shared] a listener for '${this._key}' threw: ${String(error)}`);
      }
    }
  }
}

/**
 * A node per key.
 *
 * `initial` is the owner's declared values, read while the mirror has none — the owner's tree
 * answers correctly before its first write lands. A peer passes nothing and reads `undefined`
 * there instead, since it never knows what the owner declared.
 */
export function materialize(backend: SharedBackend, keys: Shape, initial?: SharedDef): Record<string, unknown> {
  const tree: Record<string, unknown> = {};

  for (const key of keys) {
    tree[key] = new Node(backend, key, initial?.[key], initial !== undefined);
  }

  return tree;
}
