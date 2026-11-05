import { describe, expect, it, vi } from 'vitest';
import { createResourceBundle } from '@bedrock-core/i18n';
import { TranslationsRegistry } from '../src/translations';
import { State } from '../../sync/src/state';
import type { Bus } from '../../sync/src/bus';

vi.mock('@minecraft/server', () => ({ system: {} }));

function fixture(): { state: State; translations: TranslationsRegistry } {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- State only uses the transport's on/send methods in this fixture
  const bus = { on: (): (() => void) => (): void => {}, send: (): string => 'message' } as unknown as Bus;
  const state = new State(bus, 'owner');
  const translations = new TranslationsRegistry(state, 'owner');

  translations.start();

  return { state, translations };
}

describe('live translation bundles', () => {
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

  it('ignores unrelated state and removes invalidated bundles from live resolvers', () => {
    const { state, translations } = fixture();
    const resolver = translations.forLocale('en_US');
    const original = translations.bundles.get();

    state.set('owner', 'unrelated', 1);
    expect(translations.bundles.get()).toBe(original);
    translations.provide(createResourceBundle('owner', { en_US: { text: 'value' } }));
    expect(resolver('owner.text')).toBe('value');
    state.delete('owner', 'core-i18n/bundle');
    expect(resolver('owner.text')).toBeUndefined();
    expect(translations.namespaces()).toEqual([]);
    translations.stop();
    expect(() => translations.provide(createResourceBundle('owner', { en_US: {} }))).toThrow('unavailable');
  });
});
