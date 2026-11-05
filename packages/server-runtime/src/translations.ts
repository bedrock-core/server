import { createI18n, LOCALE_PROPERTY, pickLocale } from '@bedrock-core/i18n';
import type { I18n, I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
import { observable, type ReadonlyObservable, type Unsubscribe } from '@bedrock-core/observable';
import { stateKey, type State } from '@bedrock-core/sync';
import type { Player } from '@minecraft/server';
import { isRecord } from './guards';
import { isUsable } from './handle';

const DEFAULT_LOCALE = 'en_US';
const BUNDLE_KEY = stateKey<I18nBundle>('core-i18n/bundle');

type Bundles = Readonly<Record<string, I18nBundle>>;

/** Published translation bundles and synchronous resolvers over their current contents. */
export class TranslationsRegistry {
  readonly bundles: ReadonlyObservable<Bundles>;
  private readonly _source = observable<Bundles>(Object.freeze({}));
  private readonly _verbs = new Map<string, I18n<unknown>>();
  private readonly _chains = new Map<string, TranslationResolver[]>();
  private readonly _resolvers = new Map<string, TranslationResolver>();
  private _locales: Set<string> | undefined;
  private _release: Unsubscribe | undefined;

  constructor(private readonly _state: State, private readonly _self: string) {
    this.bundles = this._source;
  }

  start(): void {
    this._release?.();
    this._release = this._state.subscribe((change) => {
      if (change.key === BUNDLE_KEY) { this._refresh(); }
    });
    this._refresh();
  }

  stop(): void {
    this._release?.();
    this._release = undefined;
    this._invalidate();
    this._source.set(Object.freeze({}));
    this._resolvers.clear();
  }

  /** Publish this addon's bundle. Registration owns the service lifetime. */
  provide(bundle: I18nBundle): void {
    if (this._release === undefined) { throw new Error('translations are unavailable: register the runtime first'); }

    this._state.set(this._self, BUNDLE_KEY, bundle);
  }

  own(): I18nBundle | undefined {
    return this.of(this._self);
  }

  of(addonId: string): I18nBundle | undefined {
    return this._source.get()[addonId];
  }

  namespaces(): string[] {
    return Object.keys(this._source.get());
  }

  /** Verbs for the currently published bundle. Observe bundles before retaining this snapshot. */
  i18n(addonId: string): I18n<unknown> | undefined {
    const cached = this._verbs.get(addonId);

    if (cached !== undefined) { return cached; }

    const bundle = this.of(addonId);

    if (bundle === undefined) { return undefined; }

    const verbs = createI18n(bundle, { asDefault: false });

    this._verbs.set(addonId, verbs);

    return verbs;
  }

  /** A stable resolver that reads current bundles, including replacements published later. */
  forLocale(locale: string): TranslationResolver {
    const cached = this._resolvers.get(locale);

    if (cached !== undefined) { return cached; }

    const resolver: TranslationResolver = (key) => {
      let chain = this._chains.get(locale);

      if (chain === undefined) {
        chain = this.namespaces().reverse().flatMap((namespace) => {
          const verbs = this.i18n(namespace);

          return verbs === undefined ? [] : [verbs.forLocale(locale).resolve];
        });
        this._chains.set(locale, chain);
      }

      for (const resolve of chain) {
        const value = resolve(key);

        if (value !== undefined) { return value; }
      }

      return undefined;
    };

    this._resolvers.set(locale, resolver);

    return resolver;
  }

  /** Resolve the player's selected locale against the current published bundles. */
  forPlayer(player: Player, defaultLocale = DEFAULT_LOCALE): TranslationResolver {
    if (!isUsable(player)) { return this.forLocale(defaultLocale); }

    const override = player.getDynamicProperty(LOCALE_PROPERTY);
    const chosen = pickLocale([...this._availableLocales()], [
      typeof override === 'string' ? override : undefined,
      player.clientSystemInfo.locale,
    ], defaultLocale);

    return this.forLocale(chosen ?? defaultLocale);
  }

  private _availableLocales(): Set<string> {
    if (this._locales !== undefined) { return this._locales; }

    const locales = new Set<string>();

    for (const bundle of Object.values(this._source.get())) {
      for (const locale of Object.keys(bundle.locales)) { locales.add(locale); }

      for (const locale of Object.keys(bundle.extra ?? {})) { locales.add(locale); }
    }

    this._locales = locales;

    return locales;
  }

  private _refresh(): void {
    const next = Object.fromEntries(this._state.namespaces().flatMap((namespace) => {
      const bundle = this._state.get(namespace, BUNDLE_KEY);

      return isBundle(bundle) ? [[namespace, bundle]] : [];
    }));
    const previous = this._source.get();

    if (Object.keys(previous).length === Object.keys(next).length
      && Object.keys(next).every(namespace => previous[namespace] === next[namespace])) { return; }

    this._invalidate();
    this._source.set(Object.freeze(next));
  }

  private _invalidate(): void {
    this._verbs.clear();
    this._chains.clear();
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
