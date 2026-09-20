# @bedrock-core/i18n

## 0.2.0

### Minor Changes

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - A library's strings can be overridden by the world it runs in.
  
  A library that draws UI ships its own bundle, keyed under a namespace it shares with the rest of
  its family. A running realm has more than that: every addon present has announced a bundle, and
  one of them may carry the very same key — deliberately, to rename what the library calls something
  ("Addons" becomes "Mods"), or simply because it ships a locale the library does not.
  
  `overlay(bound, published, bundle)` is that precedence, as verbs. `t()` prefers the published value
  wherever it carries the key, so an override and an unshipped locale reach the strings a script
  renders rather than only the keys a client paints. `resolve()` and `display()` become the world's,
  so a key from any addon's bundle resolves — which is what a screen showing another addon's display
  fields needs.
  
  A realm with no published bundles gets the bound instance back untouched and allocates nothing.

## 0.1.0

### Minor Changes

- [`d0ad2c6`](https://github.com/bedrock-core/ui/commit/d0ad2c695f8b2173875a511b00c7b40f96163799) Thanks [@drav0011](https://github.com/drav0011)! - Initial release.

  TS-first localization for Bedrock addons, the runtime half of the `i18n` Regolith filter: nested TypeScript objects are the source of truth, and everything — keys, interpolation variables, plural forms — autocompletes and type-checks.

  ```ts
  import bundle from "@bedrock-core/generated/i18n";
  import { createI18n } from "@bedrock-core/i18n";

  export const i18n = createI18n(bundle);

  const { t, key, raw } = i18n.forPlayer(player);
  t(($) => $.shop.bought, { item: "Apple", price: 5 }); // server-resolved, filled string
  key(($) => $.shop.title); // the real .lang key
  raw(($) => $.shop.bought, { item: "Apple", price: 5 }); // Minecraft RawMessage — client resolves
  ```

  - **Three verbs, one idea** — prefer the client, fall back to the server. `key()` and `raw()` resolve on the client (per-player language for free, no 80-byte cap); `t()` resolves server-side for code that needs the string now. Every verb takes a selector (`$ => $.shop.bought`) or the equivalent typed dot string.
  - **Typed interpolation** — `{{var}}` placeholders in the authored template become required, closed argument properties. `raw()` arguments additionally accept any RawMessage part (nested `raw()`, `score`, `selector`) and travel as rawtext parameters.
  - **Plurals without Intl** — `_one`/`_other` (and `_zero`/`_two`/`_few`/`_many`) author-side collapse into one leaf taking `count`; the suffix is chosen by a built-in CLDR rule table, since Bedrock's engine does not guarantee `Intl.PluralRules`.
  - **Locale chain** — persisted per-player override (`setLocale`, survives rejoin) → client language → sibling region of that language (`es_MX` → `es_ES` before English) → default → any. `forPlayer` / `forLocale` return bound verb sets.
  - **`resolve(realKey)`** — the lazy measurement lookup: inverse-maps a real `.lang` key into the bundle and converts the one template it needs. No tables are materialized anywhere.
  - **`display(value)`** — bound on every verb set: any `DisplayText` (`string | RawMessage`, the shared union every text channel uses) to a plain string, for the places a key must BECOME text — breadcrumb trails, native modal headings, chat prefixes. The `resolveDisplay(resolve, value)` free function stays as the primitive for hosts binding over a custom resolver.
  - **`createResourceBundle`** — the same bundle shape built from objects at runtime, for libraries shipping their own strings and for addons not (yet) running the filter.
  - Creating the addon's instance registers it as the default translation source — `@bedrock-core/ui` measures localized `Text` children through it with zero wiring.
