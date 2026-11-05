import type { RawMessage } from '@minecraft/server';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createI18n, currentI18n } from '../index';
import { fakePlayer } from './fixture';

declare module '../index' {
  interface I18nResourceExtensions {
    readonly fixtureLibrary: {
      readonly title: 'Installed library';
      readonly api: { readonly greeting: 'Library greeting {{name}}' };
    };
  }
}

const locales = {
  en_US: {
    title: 'Magic',
    bought: 'Bought {{item}} for {{price}}',
    inventory: {
      stock_one: '{{count}} item',
      stock_other: '{{count}} items',
    },
  },
  es_ES: {
    title: 'Magia',
    bought: 'Por {{price}} compraste {{item}}',
  },
  cs_CZ: {
    inventory: {
      stock_few: '{{count}} kusy',
      stock_other: '{{count}} kusů',
    },
  },
} as const;

describe('authored locale objects', () => {
  const i18n = createI18n(locales, { namespace: 'studio_magic', asDefault: false });

  it('resolves nested keys and partial locales with typed interpolation', () => {
    expect(i18n.t($ => $.bought, { item: 'Apple', price: 4 })).toBe('Bought Apple for 4');
    expect(i18n.forLocale('es_ES').t('bought', { item: 'Apple', price: 4 })).toBe('Por 4 compraste Apple');
    expect(i18n.forLocale('es_ES').t($ => $.inventory.stock, { count: 3 })).toBe('3 items');
    expect(i18n.key('title')).toBe('studio_magic.title');
  });

  it('preserves plural argument order for locale-only categories and rich arguments', () => {
    expect(i18n.forLocale('cs_CZ').raw($ => $.inventory.stock, { count: 2 }))
      .toEqual({ translate: 'studio_magic.inventory.stock_few', with: ['2'] });
    expect(i18n.raw($ => $.bought, { item: i18n.raw($ => $.title), price: 4 }))
      .toEqual({
        translate: 'studio_magic.bought',
        with: { rawtext: [{ translate: 'studio_magic.title' }, { text: '4' }] },
      });
  });

  it('provides positional measurement and passthrough display entries', () => {
    const source = createI18n(locales, {
      namespace: 'studio_magic',
      asDefault: false,
      extra: { en_US: { 'guide.intro': 'An introduction' } },
    });

    expect(source.forLocale('es_ES').resolve('studio_magic.bought')).toBe('Por %2$s compraste %1$s');
    expect(source.resolve('guide.intro')).toBe('An introduction');
    expect(source.display(source.raw($ => $.bought, { item: 'Apple', price: 4 }))).toBe('Bought Apple for 4');
  });

  it('retains authored extras when Builder supplies compiled data and publishes the same values', () => {
    const compiled = {
      ...i18n.bundle,
      extra: { en_US: { 'guide.intro': 'Compiled intro', 'guide.fallback': 'Compiled fallback' } },
    };
    const source = createI18n(compiled, {
      asDefault: false,
      extra: {
        en_US: { 'guide.intro': 'Authored intro' },
        fr_FR: { 'guide.intro': 'Introduction française' },
      },
    });

    expect(source.resolve('guide.intro')).toBe('Authored intro');
    expect(source.forLocale('fr_FR').resolve('guide.fallback')).toBe('Compiled fallback');
    expect(source.forPlayer(fakePlayer({ locale: 'fr_FR' })).display({ translate: 'guide.intro' })).toBe('Introduction française');
    expect(source.bundle.extra).toEqual({
      en_US: { 'guide.intro': 'Authored intro', 'guide.fallback': 'Compiled fallback' },
      fr_FR: { 'guide.intro': 'Introduction française' },
    });
    expect(source.bundle.locales).toBe(compiled.locales);
    expect(compiled.extra.en_US['guide.intro']).toBe('Compiled intro');
  });

  it('supports an explicit default locale without en_US', () => {
    const source = createI18n({ es_ES: { greeting: 'Hola {{name}}' } }, {
      namespace: 'studio_magic', defaultLocale: 'es_ES', asDefault: false,
    });

    expect(source.locale).toBe('es_ES');
    expect(source.t($ => $.greeting, { name: 'Alex' })).toBe('Hola Alex');
    expect(source.forLocale('en_US').t('greeting', { name: 'Alex' })).toBe('Hola Alex');
  });

  it('registers direct instances as the addon default unless opted out', () => {
    const source = createI18n({ en_US: { title: 'Host' } }, { namespace: 'studio_host' });

    createI18n(locales, { namespace: 'library', asDefault: false });
    expect(currentI18n()).toBe(source);
  });

  it('requires an explicit namespace when no Builder-owned bundle is supplied', () => {
    expect(() => createI18n(locales)).toThrow(/namespace option outside Builder/);
  });

  it('infers inline literals and rejects invalid keys and parameters', () => {
    const inline = createI18n({ en_US: { greeting: 'Hello {{name}}', title: 'Magic' } }, { namespace: 'studio_magic', asDefault: false });

    expectTypeOf(inline.t($ => $.greeting, { name: 'Alex' })).toEqualTypeOf<string>();
    expectTypeOf(inline.raw('greeting', { name: { text: 'Alex' } })).toEqualTypeOf<RawMessage>();
    expectTypeOf(inline.key($ => $.fixtureLibrary.title)).toEqualTypeOf<string>();

    // @ts-expect-error unknown selector key
    void inline.t($ => $.unknown);
    // @ts-expect-error unknown dotted key
    void inline.t('unknown');
    // @ts-expect-error literal template variables are required
    void inline.t('greeting');
    // @ts-expect-error undeclared argument
    void inline.t('greeting', { name: 'Alex', extra: 'value' });
    // @ts-expect-error variable-free templates accept no arguments
    void inline.t('title', { name: 'Alex' });
    // @ts-expect-error plural counts remain numeric
    void i18n.t('inventory.stock', { count: 'two' });
  });

  it('rejects a default locale that is absent from the authored objects', () => {
    // @ts-expect-error the default locale must be authored
    expect(() => createI18n(locales, { namespace: 'studio_magic', defaultLocale: 'fr_FR', asDefault: false })).toThrow(/default locale/);
  });

  it('keeps installed branch types usable when authored text overrides a library literal', () => {
    const source = createI18n({ en_US: { fixtureLibrary: { title: 'Custom library title' } } }, {
      namespace: 'studio_magic', asDefault: false,
    });

    expectTypeOf(source.t($ => $.fixtureLibrary.title)).toEqualTypeOf<string>();
    expect(source.t($ => $.fixtureLibrary.title)).toBe('Custom library title');
  });

  it('retains authored sibling keys and installed parameter contracts in overlapping nested branches', () => {
    const source = createI18n({
      en_US: {
        fixtureLibrary: {
          title: 'Custom library title',
          custom: 'Own {{value}}',
          api: { local: 'Local {{amount}}', greeting: 'Hello {{name}}' },
        },
      },
    }, { namespace: 'studio_magic', asDefault: false });

    expect(source.t($ => $.fixtureLibrary.custom, { value: 'text' })).toBe('Own text');
    expect(source.t('fixtureLibrary.api.local', { amount: 3 })).toBe('Local 3');
    expectTypeOf(source.raw($ => $.fixtureLibrary.api.greeting, { name: 'Alex' })).toEqualTypeOf<RawMessage>();
    expectTypeOf(source.t('fixtureLibrary.title')).toEqualTypeOf<string>();

    // @ts-expect-error authored sibling interpolation stays required
    void source.t('fixtureLibrary.custom');
    // @ts-expect-error nested authored sibling interpolation stays closed
    void source.t($ => $.fixtureLibrary.api.local, { amount: 3, extra: true });
    // @ts-expect-error installed library interpolation stays required
    void source.t($ => $.fixtureLibrary.api.greeting);
    // @ts-expect-error installed library argument names remain closed
    void source.raw('fixtureLibrary.api.greeting', { name: 'Alex', extra: 'value' });
    // @ts-expect-error unknown siblings remain unavailable
    void source.t($ => $.fixtureLibrary.api.unknown);
  });
});
