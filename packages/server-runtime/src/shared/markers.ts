/**
 * Markers for a `shared` declaration. A value in the declaration is a leaf; a plain object is a
 * branch of leaves. `open()` lets any realm write the leaf or every leaf under the branch;
 * `persisted()` writes it to the world on every change and restores it on boot; `leaf()` keeps an
 * object as one value under one key instead of a branch. Markers nest — `persisted(open(0))` —
 * and a marker on a branch is inherited by everything under it.
 *
 * The flags are carried in the type as well as the value, so a peer that imports the owner's
 * declaration type sees `set` only on the leaves the owner opened.
 */
const MARK: unique symbol = Symbol('core.shared.marked');

export interface Marked<T, Leaf extends boolean = false, Open extends boolean = false> {
  readonly [MARK]: true;
  readonly value: T;
  readonly leaf: Leaf;
  readonly open: Open;
  readonly persisted: boolean;
}

/** The declared value behind a marker, or the value itself. */
export type Unmarked<N> = N extends Marked<infer V, boolean, boolean> ? V : N;

type LeafFlag<N> = N extends Marked<unknown, infer L, boolean> ? L : false;

type OpenFlag<N> = N extends Marked<unknown, boolean, infer O> ? O : false;

export function isMarked(value: unknown): value is Marked<unknown, boolean, boolean> {
  return typeof value === 'object' && value !== null && MARK in value;
}

function mark<N, Leaf extends boolean, Open extends boolean>(node: N, flags: { leaf?: true; open?: true; persisted?: true }): Marked<Unmarked<N>, Leaf, Open> {
  const inner = isMarked(node) ? node : undefined;
  const value: unknown = inner === undefined ? node : inner.value;
  const marked: Marked<unknown, boolean, boolean> = {
    [MARK]: true,
    value,
    leaf: flags.leaf ?? inner?.leaf ?? false,
    open: flags.open ?? inner?.open ?? false,
    persisted: flags.persisted ?? inner?.persisted ?? false,
  };

  return marked as Marked<Unmarked<N>, Leaf, Open>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}

/** Any realm may write this leaf, or every leaf under this branch. Last write wins, as before. */
export function open<N>(node: N): Marked<Unmarked<N>, LeafFlag<N>, true> {
  return mark(node, { open: true });
}

/** This leaf, or every leaf under this branch, is written to the world on change and restored on boot. */
export function persisted<N>(node: N): Marked<Unmarked<N>, LeafFlag<N>, OpenFlag<N>> {
  return mark(node, { persisted: true });
}

/** Keep an object as one value under one key — a leaf with an object type — instead of a branch. */
export function leaf<N>(node: N): Marked<Unmarked<N>, true, OpenFlag<N>> {
  return mark(node, { leaf: true });
}
