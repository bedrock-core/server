import { createI18n, LOCALE_PROPERTY, pickLocale } from '@bedrock-core/i18n';
import type { I18n, I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
import { observable, type ReadonlyObservable, type Unsubscribe } from '@bedrock-core/observable';
import type { Player } from '@minecraft/server';
import type { Declaration, Installation } from '../library';
import type { Runtime } from '../runtime';
import { isUsable } from '../handle';
import { Registry } from '../registries/base';
import { createRegistryReader } from '../registries/registration';
import { registryOf } from '../installation';
import type { RegistryReader } from '../registries/view';
import { publishTranslations, TRANSLATIONS } from './publish';

const DEFAULT_LOCALE = 'en_US';

interface TranslationStorage {
  own(): I18nBundle | undefined;
  provide(bundle: I18nBundle): void;
  open(): Pick<RegistryReader<I18nBundle>, 'snapshot' | 'stop'>;
}

type Bundles = Readonly<Record<string, I18nBundle>>;

/** Published translation bundles and synchronous resolvers over their current contents. */
class TranslationsRegistry extends Registry<I18nBundle, Bundles> {
  readonly bundles: ReadonlyObservable<Bundles>;
  private readonly _source = observable<Bundles>(Object.freeze({}));
  private readonly _verbs = new Map<string, I18n<unknown>>();
  private readonly _chains = new Map<string, TranslationResolver[]>();
  private readonly _resolvers = new Map<string, TranslationResolver>();
  private _locales: Set<string> | undefined;
  private _release: Unsubscribe | undefined;
  private _registry: ReturnType<TranslationStorage['open']> | undefined;
  private _active = false;

  constructor(private readonly _storage: TranslationStorage, private readonly _self: string) {
    super();
    this.bundles = {
      get: (): Bundles => this._source.get(),
      subscribe: (listener): Unsubscribe => this._source.subscribe(listener),
    };
  }

  get snapshot(): ReadonlyObservable<Bundles> { return this.bundles; }

  get(id: string): I18nBundle | undefined { return this.of(id); }

  start(): void {
    if (this._active) { return; }

    this._active = true;

    try {
      this._registry = this._storage.open();
      this._release = this._registry.snapshot.subscribe(() => this._refresh());
      this._refresh();
    } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    this._release?.();
    this._release = undefined;
    this._active = false;
    this._registry?.stop();
    this._registry = undefined;
    this._invalidate();
    this._source.set(Object.freeze({}));
    this._resolvers.clear();
  }

  /** Replace this addon's bundle without changing ownership of the built-in publisher. */
  provide(bundle: I18nBundle): void {
    if (!this._active) { throw new Error('translations are unavailable: register the runtime first'); }

    this._storage.provide(bundle);

    this._refresh();
  }

  own(): I18nBundle | undefined {
    return this._active ? this._storage.own() : undefined;
  }

  of(addonId: string): I18nBundle | undefined {
    if (addonId === this._self) { return this.own(); }

    const bundles = this._source.get();

    return Object.hasOwn(bundles, addonId) ? bundles[addonId] : undefined;
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
    const next = this._registry === undefined
      ? {}
      : Object.fromEntries(Object.entries(this._registry.snapshot.get().entries).map(([namespace, entry]) => [namespace, entry.value]));
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

declare module '@bedrock-core/server-runtime' {
  interface RuntimeServices {
    'core:translations': TranslationsRegistry;
  }
}

/** Install translation lookup and resolvers. Core publishes local bundles independently. */
export function registerTranslations(): Declaration<TranslationsRegistry> {
  return { install(runtime, lifetime): Installation<TranslationsRegistry> {
    const host = registryOf(runtime);
    const value = new TranslationsRegistry({
      open: (): RegistryReader<I18nBundle> => createRegistryReader(runtime, TRANSLATIONS, { select: candidates => candidates.find(candidate => candidate.provider === candidate.id) ?? candidates[0] }),
      own: (): I18nBundle | undefined => {
        const bundle = host.publication(TRANSLATIONS.id)?.get(runtime.id);

        return TRANSLATIONS.accepts(bundle) ? bundle : undefined;
      },
      provide: (bundle): void => publishTranslations(runtime, bundle),
    }, runtime.id);

    lifetime.defer(() => value.stop());
    value.start();
    runtime.provideService('core:translations', value);

    return { value };
  } };
}

/** Retrieve the translation registry installed on this Runtime. */
export function translations(runtime: Runtime): TranslationsRegistry {
  const value = runtime.service('core:translations');

  if (value === undefined) { throw new Error('translations are not registered: include registerTranslations() in core.register()'); }

  return value;
}

export type { I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
export type { TranslationsRegistry as Translations };

export { publishTranslations } from './publish';
