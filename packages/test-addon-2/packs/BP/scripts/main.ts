/**
 * Test addon "Shop" — the second half of the cross-addon example. It shares a creator but a
 * different namespace from "Economy"; it depends on the `economy` namespace, calls Economy
 * over RPC, and lights up an optional feature when a `leaderboard` addon is present.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import translationKeys from '@bedrock-core/generated/translation-keys';
import guides from '@bedrock-core/generated/guides';
import { configDef, setupShop } from './example';

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys shipped in this addon's RP
// (texts/en_US.lang); UIs localize them per player language, and Bedrock falls back to
// the literal string when no .lang entry matches. The generated translations and guide
// manifest (from the Regolith filters) and the config schema ride along as optional
// fields; the typed config accessors register() returns are unused here — Shop only
// exposes its config to the UI and to cross-addon `core.config.of()` readers.
core.register({
  creator: 'drav0011',
  pack: 'shop',
  packName: 'drav0011.shop.name',
  creatorName: 'drav0011.shop.creator',
  version: '1.0.0',
  description: 'drav0011.shop.description',
  icon: 'textures/ui/shop/icon',
  thumbnail: 'textures/ui/shop/thumbnail',
  dependencies: ['drav0011_economy'],
  optionalDependencies: ['drav0011_leaderboard'],
  translations: translationKeys,
  guide: guides,
  config: configDef,
});

setupShop();
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
