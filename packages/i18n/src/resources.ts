/**
 * Build an {@link I18nBundle} from nested resource modules at runtime — no
 * Builder stage involved. Two audiences:
 *
 * - **Libraries** (config, future bedrock-core packages): their resources ship
 *   inside the package and the consuming addon's i18n stage folds them into the
 *   `.lang`; the library itself still wants typed verbs over its own strings
 *   for breadcrumbs, native modal headings, and any place a key must become a
 *   string. `createResourceBundle('core', { en_US })` gives it exactly the
 *   bundle shape `createI18n` expects, namespaced the way the stage emits it.
 * - **Addons without the stage**: everything works minus what only the build
 *   can do (`.lang` emission, vanilla branch, cross-locale checks).
 */
import type { I18nBundle } from './bundle';
import { templateVars } from './interpolate';

/** Nested resource module shape: strings at the leaves, objects in between. */
export interface ResourceTree {
  readonly [key: string]: string | ResourceTree;
}

/** Authored locale codes mapped to nested resource trees. */
export type ResourceLocales = Readonly<Record<string, ResourceTree>>;

function flatten(tree: ResourceTree, prefix: string, into: Record<string, string>): void {
  for (const [segment, value] of Object.entries(tree)) {
    const path = prefix === '' ? segment : `${prefix}.${segment}`;

    if (typeof value === 'string') { into[path] = value; } else { flatten(value, path, into); }
  }
}

export interface ResourceBundleOptions {
  /** The locale defining the type and the recorded argument order. Defaults to `en_US`. */
  readonly defaultLocale?: string;
  /**
   * `.lang`-passthrough entries (locale → REAL key → display string) to carry
   * for measurement — the runtime twin of the filter's `extra` section, for
   * keys that never were resource paths (config bakes the framework guide's
   * keys in this way).
   */
  readonly extra?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * @param namespace the branch these keys live under world-wide (`core` for
 *                  bedrock-core's own; an addon namespace otherwise)
 * @param locales   one nested resource object per locale; the default locale
 *                  defines the type and the recorded argument order
 */
export function createResourceBundle<const L extends ResourceLocales & { readonly en_US: ResourceTree }>(
  namespace: string,
  locales: L,
  options?: ResourceBundleOptions & { readonly defaultLocale?: 'en_US' },
): I18nBundle & { readonly resources?: L['en_US'] };
export function createResourceBundle<const L extends ResourceLocales, const D extends keyof L & string>(
  namespace: string,
  locales: L,
  options: ResourceBundleOptions & { readonly defaultLocale: D },
): I18nBundle & { readonly resources?: L[D] };

export function createResourceBundle(
  namespace: string,
  locales: ResourceLocales,
  options: ResourceBundleOptions = {},
): I18nBundle {
  const { defaultLocale = 'en_US', extra } = options;

  if (!Object.prototype.hasOwnProperty.call(locales, defaultLocale)) {
    throw new Error(`The default locale '${defaultLocale}' is not present in the resource objects`);
  }

  const tables: Record<string, Record<string, string>> = {};

  for (const [locale, tree] of Object.entries(locales)) {
    const flat: Record<string, string> = {};

    flatten(tree, '', flat);
    tables[locale] = flat;
  }

  const args: Record<string, readonly string[]> = {};

  for (const [path, template] of Object.entries(tables[defaultLocale] ?? {})) {
    const vars = templateVars(template);

    if (vars.length > 0) { args[path] = vars; }
  }

  return { namespace, defaultLocale, libs: [], args, locales: tables, ...(extra !== undefined && { extra }) };
}
