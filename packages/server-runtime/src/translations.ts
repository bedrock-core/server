/**
 * `core.translations` — every addon's i18n bundle, announced, with resolvers over all of them.
 *
 * Each addon announces its {@link I18nBundle} — the module the i18n Regolith filter generates,
 * or `createResourceBundle`'s runtime equivalent — under `core-i18n/bundle` via
 * `core.translations.provide(bundle)`. The bundle itself travels: templates stay in
 * `{{var}}` form with their recorded argument order. Peers get two views, both lazy over the
 * announced bundles:
 *
 * - **Verbs** — `i18n(addonId)` wraps a peer's bundle in `createI18n`, giving `t()` / `key()` /
 *   `raw()` / `resolve()` over another addon's strings, loosely typed since their resource
 *   tree's types never travel.
 * - **Resolution** — `forLocale()` / `forPlayer()` return a {@link TranslationResolver} that
 *   chains every addon's bundle, later registrations overriding earlier ones the way Bedrock's
 *   world-level `.lang` merge does. Nothing is flattened or copied; each lookup reads the winning
 *   bundle's objects and converts the one template it needs.
 *
 * Registry display fields (`packName`, `description`, `creatorName`) are translation keys
 * shipped in each addon's generated `.lang`, so this is what lets one addon's UI resolve
 * another addon's keys server-side.
 */
import { createI18n, LOCALE_PROPERTY, pickLocale } from '@bedrock-core/i18n';
import type { I18n, I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
import type { State, Unsubscribe } from '@bedrock-core/sync';
import type { Player } from '@minecraft/server';
import { Announcement, isRecord } from './announcement';
import { isUsable } from './handle';

/** Locale `forPlayer` falls back to when no candidate locale is published. */
const DEFAULT_LOCALE = 'en_US';

/** Each addon's i18n bundle, announced, with resolvers over all of them. */
export class TranslationsRegistry extends Announcement<I18nBundle> {
  /** Caches over announced bundles, cleared whenever any addon re-publishes. */
  private readonly _verbs = new Map<string, I18n<unknown> | undefined>();
  private readonly _resolvers = new Map<string, TranslationResolver>();
  private _locales: Set<string> | undefined;
  private _release: Unsubscribe | undefined;

  constructor(state: State, addonId: string) {
    super(state, addonId, 'i18n/bundle', isBundle);
  }

  start(): void {
    this._release = this.subscribe(() => this.invalidate());
  }

  stop(): void {
    this._release?.();
    this._release = undefined;
    this.invalidate();
  }

  /**
   * The verbs over one addon's announced strings — `t()`, `key()`, `raw()`, `resolve()`,
   * `forPlayer()` — exactly what `createI18n` gives that addon locally, minus its compile-time
   * resource types. `undefined` until that addon publishes.
   */
  i18n(addonId: string): I18n<unknown> | undefined {
    if (this._verbs.has(addonId)) { return this._verbs.get(addonId); }

    const bundle = this.of(addonId);
    // Never the default instance: these are peers' bundles, not this addon's.
    const verbs = bundle ? createI18n(bundle, { asDefault: false }) : undefined;

    this._verbs.set(addonId, verbs);

    return verbs;
  }

  /**
   * One resolver over every announced bundle, for a single locale. Later registrations win
   * collisions, mirroring Bedrock's world-level `.lang` merge, so the chain probes namespaces in
   * reverse. Cached per locale; rebuilt when any addon re-publishes.
   */
  forLocale(locale: string): TranslationResolver {
    const cached = this._resolvers.get(locale);

    if (cached) { return cached; }

    const chain: TranslationResolver[] = [];

    for (const ns of this.namespaces().reverse()) {
      const verbs = this.i18n(ns);

      if (verbs) { chain.push(verbs.forLocale(locale).resolve); }
    }

    const resolver: TranslationResolver = (key) => {
      for (const resolve of chain) {
        const value = resolve(key);

        if (value !== undefined) { return value; }
      }

      return undefined;
    };

    this._resolvers.set(locale, resolver);

    return resolver;
  }

  /**
   * The chained resolver for a specific player, through the same chain the i18n engine uses:
   * persisted override → client locale → sibling region of that language → `defaultLocale` →
   * anything published. Resolves nothing when nothing is published — a missing key already
   * falls back to rendering the literal key.
   */
  forPlayer(player: Player, defaultLocale = DEFAULT_LOCALE): TranslationResolver {
    // Both reads below throw on an invalidated handle, and callers reach this from event
    // subscribers. A player who is gone has no locale to prefer, so fall back to the default.
    if (!isUsable(player)) { return this.forLocale(defaultLocale); }

    const override = player.getDynamicProperty(LOCALE_PROPERTY);
    const chosen = pickLocale([...this.availableLocales()], [
      typeof override === 'string' ? override : undefined,
      player.clientSystemInfo.locale,
    ], defaultLocale);

    return this.forLocale(chosen ?? defaultLocale);
  }

  /** Every locale any addon has published (resource locales and passthrough alike). */
  private availableLocales(): Set<string> {
    if (this._locales) { return this._locales; }

    const locales = new Set<string>();

    for (const ns of this.namespaces()) {
      const bundle = this.of(ns);

      if (!bundle) { continue; }

      for (const locale of Object.keys(bundle.locales)) { locales.add(locale); }

      for (const locale of Object.keys(bundle.extra ?? {})) { locales.add(locale); }
    }

    this._locales = locales;

    return locales;
  }

  private invalidate(): void {
    this._verbs.clear();
    this._resolvers.clear();
    this._locales = undefined;
  }
}

/** A locale table: a record whose every value is a string. An empty record qualifies. */
function isFlatMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) { return false; }

  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') { return false; }
  }

  return true;
}

function isFlatMapRecord(value: unknown): value is Record<string, Record<string, string>> {
  return isRecord(value) && Object.values(value).every(isFlatMap);
}

/** The shape `createI18n` relies on, so one addon's bad payload cannot poison the chain. */
function isBundle(value: unknown): value is I18nBundle {
  if (!isRecord(value)) { return false; }

  if (typeof value['namespace'] !== 'string' || typeof value['defaultLocale'] !== 'string') { return false; }

  if (!Array.isArray(value['libs']) || !value['libs'].every(entry => typeof entry === 'string')) { return false; }

  const args = value['args'];

  if (!isRecord(args)) { return false; }

  for (const order of Object.values(args)) {
    if (!Array.isArray(order) || !order.every(name => typeof name === 'string')) { return false; }
  }

  if (!isFlatMapRecord(value['locales'])) { return false; }

  return value['extra'] === undefined || isFlatMapRecord(value['extra']);
}
