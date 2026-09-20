# @bedrock-core/i18n

![Logo](https://raw.githubusercontent.com/bedrock-core/ui/main/assets/logo/title.png)

Localization for Minecraft Bedrock addons: typed keys, typed interpolation and plurals, resolved
on the **client** in each player's own language wherever possible and on the **server** whenever
your code needs the actual string — the runtime half of a two-part system, paired with the `i18n`
Regolith filter that turns your locale modules into `.lang` files, a runtime bundle, and the types
every verb below infers from.

## Install

Already have `@bedrock-core/server`? It is reachable as `@bedrock-core/server/i18n` — nothing to add.
Standalone:

```bash
yarn add @bedrock-core/i18n
```

## Usage

```ts
// packs/data/i18n/en_US.ts — `as const` is what lets the compiler infer the key space
export default {
  shop: {
    title: 'Shop',
    bought: 'You bought {{item}} for {{price}} emeralds.',
  },
} as const;
```

```ts
// BP/scripts/i18n.ts — the addon's one instance
import { createI18n } from '@bedrock-core/i18n';
import bundle from '@bedrock-core/generated/i18n';
import type { Player } from '@minecraft/server';

export const i18n = createI18n(bundle);

export function receipt(player: Player, item: string, price: number): void {
  // Bind the verbs to this player's locale chain.
  const { key, raw, t } = i18n.forPlayer(player);

  key($ => $.shop.title);                    // 'drav0011_shop.shop.title' — the client resolves it
  raw($ => $.shop.bought, { item, price });  // RawMessage — the client resolves and fills it
  t($ => $.shop.bought, { item, price });    // 'You bought Apple for 5 emeralds.' — here, now
}
```

## Documentation

https://bedrock-core.drav.dev/docs/i18n

## License

MIT
