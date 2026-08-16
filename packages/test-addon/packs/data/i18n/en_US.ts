/**
 * This addon's text, TS-first — the i18n filter turns this into namespaced
 * .lang entries, the runtime bundle, and the types behind `key($ => $.…)`.
 *
 * `meta.*` are the registry display fields: the manifest's packName /
 * description / creatorName ARE these keys (via `i18n.key()`), other addons
 * render them, and Bedrock resolves them from the world's merged languages.
 */
export default {
  meta: {
    name: 'Economy',
    description: '§7Provides player balances to other addons and makes the description very long to see if it works correctly when it should work and do the things it should do and be longer then you so it makes it larger and larger and we see if there is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happensere is scroll or not or whatever happens',
    creator: 'DrAv0011, Bedrock Tweaks',
  },
} as const;
