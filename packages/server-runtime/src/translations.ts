/**
 * Cross-addon translation sync — i18n-bundle native, no tables anywhere.
 *
 * Each addon publishes its {@link I18nBundle} — the module the i18n Regolith
 * filter generates, or `createResourceBundle`'s runtime equivalent — via
 * `core.register({ translations: bundle })`. The registry replicates the
 * bundle itself: templates stay in `{{var}}` form with their recorded argument
 * order. Peers get two views, both lazy over the bundles:
 *
 * - **Verbs** — `of(addonId)` wraps a peer's bundle in `createI18n`, giving
 *   `t()`/`key()`/`raw()`/`resolve()` over another addon's strings (loosely
 *   typed: their resource tree's types never travel).
 * - **Resolution** — `forLocale()`/`forPlayer()` return a
 *   {@link TranslationResolver} that chains every addon's bundle, later
 *   registrations overriding earlier ones the way Bedrock's world-level
 *   `.lang` merge does. Nothing is flattened or copied; each lookup reads the
 *   winning bundle's objects and converts the one template it needs.
 *
 * Registry display fields (`packName`, `description`, `creatorName`) ARE
 * translation keys shipped in each addon's generated `.lang` — this registry
 * is what lets one addon's UI measure and resolve another addon's keys
 * server-side. Late joiners are covered by sync's state snapshot exchange.
 */
import { createI18n, LOCALE_PROPERTY, pickLocale } from '@bedrock-core/i18n';
import type { I18n, I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
import { stateKey } from '@bedrock-core/sync';
import type { State, Unsubscribe } from '@bedrock-core/sync';
import type { Player } from '@minecraft/server';

/** Locale `forPlayer` falls back to when no candidate locale is published. */
const DEFAULT_LOCALE = 'en_US';

/** State key each addon publishes its bundle under (namespace = the addon's namespace). */
const TRANSLATIONS_STATE_KEY = stateKey<I18nBundle>('core-i18n/bundle');

export type TranslationsChangeListener = () => void;

export class TranslationsRegistry {
  private readonly _state: State;
  private readonly _addonId: string;
  private readonly _listeners = new Set<TranslationsChangeListener>();
  private readonly _disposers: Unsubscribe[] = [];
  /** Caches over replicated bundles, cleared whenever any addon re-publishes. */
  private readonly _verbs = new Map<string, I18n<unknown> | undefined>();
  private readonly _resolvers = new Map<string, TranslationResolver>();
  private _locales: Set<string> | undefined;

  constructor(state: State, addonId: string) {
    this._state = state;
    this._addonId = addonId;
  }

  start(): void {
    this._disposers.push(
      this._state.subscribe((change) => {
        if (change.key !== TRANSLATIONS_STATE_KEY) { return; }

        this.invalidate();
        this.emitChange();
      }),
    );
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    this._listeners.clear();
    this.invalidate();
  }

  /**
   * Publish this addon's bundle to replicated state so every addon can resolve
   * its strings. Usually declared up front via `core.register({ translations })`;
   * call directly to publish late or replace the bundle.
   */
  provide(bundle: I18nBundle): void {
    this._state.set(this._addonId, TRANSLATIONS_STATE_KEY, bundle);
  }

  /**
   * The verbs over one addon's published strings — `t()`, `key()`, `raw()`,
   * `resolve()`, `forPlayer()` — exactly what `createI18n` gives that addon
   * locally, minus its compile-time resource types (those never travel; paths
   * are plain strings here). `undefined` until that addon publishes.
   */
  of(addonId: string): I18n<unknown> | undefined {
    if (this._verbs.has(addonId)) { return this._verbs.get(addonId); }

    const bundle = this.publishedBundle(addonId);
    // NEVER the default instance — these are peers' bundles, not this addon's.
    const verbs = bundle ? createI18n(bundle, { asDefault: false }) : undefined;

    this._verbs.set(addonId, verbs);

    return verbs;
  }

  /** The raw bundle an addon published, or `undefined`. Local-mirror read. */
  bundleOf(addonId: string): I18nBundle | undefined {
    return this.publishedBundle(addonId);
  }

  /**
   * One resolver over every published bundle, for a SINGLE locale. Later
   * registrations win collisions (mirroring Bedrock's world-level `.lang`
   * merge), so the chain probes namespaces in reverse. Cached per locale;
   * rebuilt when any addon re-publishes.
   */
  forLocale(locale: string): TranslationResolver {
    const cached = this._resolvers.get(locale);

    if (cached) { return cached; }

    const chain: TranslationResolver[] = [];

    for (const ns of [...this._state.namespaces()].reverse()) {
      const verbs = this.of(ns);

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
   * The chained resolver for a specific player, through the same chain the
   * i18n engine uses: persisted override → client locale → sibling region of
   * that language → `defaultLocale` → anything published. Resolves nothing
   * when nothing is published — a missing key already falls back to rendering
   * the literal key.
   */
  forPlayer(player: Player, defaultLocale = DEFAULT_LOCALE): TranslationResolver {
    const override = player.getDynamicProperty(LOCALE_PROPERTY);
    const chosen = pickLocale([...this.availableLocales()], [
      typeof override === 'string' ? override : undefined,
      player.clientSystemInfo.locale,
    ], defaultLocale);

    return this.forLocale(chosen ?? defaultLocale);
  }

  /** Notified when any addon's published bundle changes (coarse — rebuild via `forLocale`/`forPlayer`/`of`). */
  subscribe(listener: TranslationsChangeListener): Unsubscribe {
    this._listeners.add(listener);

    return (): void => {
      this._listeners.delete(listener);
    };
  }

  /** Every locale any addon has published (resource locales and passthrough alike). */
  private availableLocales(): Set<string> {
    if (this._locales) { return this._locales; }

    const locales = new Set<string>();

    for (const ns of this._state.namespaces()) {
      const bundle = this.publishedBundle(ns);

      if (!bundle) { continue; }

      for (const locale of Object.keys(bundle.locales)) { locales.add(locale); }

      for (const locale of Object.keys(bundle.extra ?? {})) { locales.add(locale); }
    }

    this._locales = locales;

    return locales;
  }

  /**
   * The bundle an addon published under this namespace, or `undefined` if
   * none/malformed — one addon publishing a bad payload can't poison the
   * chain for everyone else.
   */
  private publishedBundle(ns: string): I18nBundle | undefined {
    const value = this._state.get(ns, TRANSLATIONS_STATE_KEY);

    return isBundle(value) ? value : undefined;
  }

  private invalidate(): void {
    this._verbs.clear();
    this._resolvers.clear();
    this._locales = undefined;
  }

  private emitChange(): void {
    for (const listener of this._listeners) { listener(); }
  }
}

/** True for any non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a locale table: a record whose every value is a string.
 * An empty record qualifies — nothing contradicts it, and merging it is a no-op.
 */
function isFlatMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) { return false; }

  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') { return false; }
  }

  return true;
}

/** True when every value of a record satisfies {@link isFlatMap}. */
function isFlatMapRecord(value: unknown): value is Record<string, Record<string, string>> {
  return isRecord(value) && Object.values(value).every(isFlatMap);
}

/**
 * Structural validation of a replicated bundle — the shape `createI18n`
 * relies on. Narrows so callers avoid an `as` cast.
 */
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
