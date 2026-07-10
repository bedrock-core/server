/**
 * Test addon "Shop" — the second half of the cross-addon example. It shares a creator but a
 * different namespace from "Economy"; it depends on the `economy` namespace, calls Economy
 * over RPC, and lights up an optional feature when a `leaderboard` addon is present.
 */
import { core } from '@bedrock-core/server-runtime';
import translationKeys from '@bedrock-core/generated/translation-keys';
import { setupShop } from './example';
import { setupRuntimeUI } from './ui';

// register() brings the addon online — no separate start(). Display fields are
// translation keys shipped in this addon's RP (texts/en_US.lang); UIs localize
// them per player language, and Bedrock falls back to the literal string when
// no .lang entry matches.
core.register({
  creator: 'drav0011',
  namespace: 'bc_shop',
  name: 'drav0011.bc_shop.name',
  creatorName: 'drav0011.bc_shop.creator',
  version: '1.0.0',
  description: 'drav0011.bc_shop.description',
  icon: 'textures/ui/bc_shop/icon',
  thumbnail: 'textures/ui/bc_shop/thumbnail',
  dependencies: ['drav0011:bc_economy'],
  optionalDependencies: ['drav0011:bc_leaderboard'],
});
// Publish this addon's translation keys — core.translations.all() merges every
// addon's published map for UI layout lookups.
core.translations.provide(translationKeys);
setupShop();
setupRuntimeUI(core);
