/**
 * Laying the world's published translations over a library's own.
 *
 * A library that draws UI ships its strings in its own bundle, keyed under a namespace it
 * shares with the rest of its family. At runtime the realm has more than that: every addon
 * present has announced a bundle, and one of them may carry the very same key — deliberately,
 * to rename what the library calls something ("Addons" becomes "Mods"), or simply because it
 * ships a locale the library does not.
 *
 * {@link overlay} is that precedence, as verbs:
 *
 * - `t()` prefers the published value wherever it carries the key, so an override and an
 *   unshipped locale reach the strings a script renders, not only the keys a client paints.
 * - `resolve()` becomes the world's, so a key from ANY addon's bundle resolves — which is what
 *   a screen showing another addon's display fields needs.
 * - `display()` binds to that same resolver, for the same reason.
 */
import type { BoundI18n, TranslationResolver } from './createI18n';
import type { I18nBundle } from './bundle';
import { resolveDisplay, type DisplayText } from './display';
import { interpolate } from './interpolate';
import type { Interp } from './types';

/** The overloaded verbs, widened to the loose shape this file calls them through. */
type LooseVerb = (selector: unknown, args?: Readonly<Record<string, Interp>>) => string;

/**
 * `bound`, with `published` taking precedence for every key it carries.
 *
 * `bundle` is the one `bound` came from: a published value is in positional `%N$s` form, so
 * interpolating it needs that bundle's recorded argument order. Returns `bound` untouched when
 * nothing is published, so a realm with no bundles allocates nothing.
 */
export function overlay<R>(
  bound: BoundI18n<R>,
  published: TranslationResolver | null | undefined,
  bundle: I18nBundle,
): BoundI18n<R> {
  if (!published) { return bound; }

  const prefix = `${bundle.namespace}.`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- widening the overloaded verbs to their loose implementation shape
  const { key: keyOf, t: tOf } = bound as unknown as { key: LooseVerb; t: LooseVerb };

  const t = (selector: unknown, args?: Readonly<Record<string, Interp>>): string => {
    const realKey = keyOf(selector, args);
    const value = published(realKey);

    if (value === undefined) { return tOf(selector, args); }

    if (args === undefined) { return value; }

    const path = realKey.startsWith(prefix) ? realKey.slice(prefix.length) : realKey;
    const order = bundle.args[path];

    return interpolate(value, order === undefined ? args : order.map(name => args[name]));
  };

  const display = (value: DisplayText): string => resolveDisplay(published, value);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- restoring the typed surface over the published-aware t
  return { ...bound, t, resolve: published, display } as BoundI18n<R>;
}
