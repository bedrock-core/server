import { vi } from 'vitest';
vi.mock('@minecraft/server', () => ({ system: { run: vi.fn(() => 1), clearRun: vi.fn() } }));
import { describe, expect, it } from 'vitest';
import { createResourceBundle, type I18nBundle } from '@bedrock-core/i18n';
import { observable } from '@bedrock-core/observable';
import { registerTranslations, type Translations } from '../src/i18n';
import { TRANSLATIONS } from '../src/i18n/publish';
import { RegistryStore } from '../src/registries/store';
import type { RegistrySnapshot } from '../src/registries/view';
import type { Runtime } from '../src/runtime';

const context = vi.hoisted(() => ({ host: vi.fn(), reader: vi.fn() }));

vi.mock('../src/installation', async importOriginal => ({
  ...await importOriginal<typeof import('../src/installation')>(),
  registryOf: context.host,
}));
vi.mock('../src/registries/registration', () => ({ createRegistryReader: context.reader }));

function fixture(): { publication: RegistryStore<I18nBundle>; translations: Translations } {
  const descriptor = { id: TRANSLATIONS.id, contract: 1, revision: 1 };
  const publication = new RegistryStore<I18nBundle>(descriptor, TRANSLATIONS, {}, () => {});
  const snapshot = observable<RegistrySnapshot<I18nBundle>>({ status: 'ready', providers: [], entries: {} });

  publication.snapshot.subscribe((value) => {
    snapshot.set({ status: 'ready', providers: [], entries: Object.fromEntries(Object.entries(value.entries).map(([id, bundle]) => [id, {
      id, value: bundle, provider: 'owner', instanceId: 'owner-instance', descriptor, version: value.version, stale: false,
    }])) });
  });
  context.host.mockReturnValue({ publication: () => publication });
  context.reader.mockReturnValue({ snapshot, stop(): void {} });
  const host = { id: 'owner', provideService: vi.fn() };
  // The fixture host supplies the Runtime operations used by this declaration.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const runtime = host as unknown as Runtime;
  const { value: translations } = registerTranslations().install(runtime, { defer: () => undefined });

  expect(host.provideService).toHaveBeenCalledExactlyOnceWith('core:translations', translations);

  return { publication, translations };
}

describe('live translation bundles', () => {
  it('exposes the current owned bundle inside snapshot notifications', () => {
    const { translations } = fixture();
    const seen: (I18nBundle | undefined)[] = [];
    const first = createResourceBundle('owner', { en_US: { text: 'first' } });
    const second = createResourceBundle('owner', { en_US: { text: 'second' } });

    translations.bundles.subscribe(() => { seen.push(translations.own()); });
    translations.provide(first);
    translations.provide(second);
    expect(seen).toEqual([first, second]);
    translations.stop();
  });

  it('keeps retained resolvers current and preserves namespace ordering on replacement', () => {
    const { translations } = fixture();
    const resolver = translations.forLocale('en_US');
    const updates: string[][] = [];

    translations.bundles.subscribe((next) => { updates.push(Object.keys(next)); });
    translations.provide(createResourceBundle('owner', { en_US: { text: 'first' } }));
    expect(resolver('owner.text')).toBe('first');
    translations.provide(createResourceBundle('owner', { en_US: { text: 'second' } }));
    expect(resolver('owner.text')).toBe('second');
    expect(translations.forLocale('en_US')).toBe(resolver);
    expect(updates).toEqual([['owner'], ['owner']]);
    expect(translations.own()).toBe(translations.of('owner'));
    translations.stop();
    expect(resolver('owner.text')).toBeUndefined();
    expect(translations.bundles.get()).toEqual({});
  });

  it('removes withdrawn bundles from live resolvers and rejects publication after shutdown', () => {
    const { publication, translations } = fixture();
    const resolver = translations.forLocale('en_US');

    translations.provide(createResourceBundle('owner', { en_US: { text: 'value' } }));
    expect(resolver('owner.text')).toBe('value');
    publication.delete('owner');
    expect(resolver('owner.text')).toBeUndefined();
    expect(translations.namespaces()).toEqual([]);
    translations.stop();
    expect(() => translations.provide(createResourceBundle('owner', { en_US: {} }))).toThrow('unavailable');
  });
});
