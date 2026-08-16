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
    name: 'Shop',
    description: '§7Sells items for currency',
    creator: 'DrAv0011',
  },
} as const;
