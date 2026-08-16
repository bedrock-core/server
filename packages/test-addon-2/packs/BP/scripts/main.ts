/**
 * Test addon "Shop" — the second half of the cross-addon example. It shares a creator but a
 * different namespace from "Economy"; it depends on the `economy` namespace, calls Economy
 * over RPC, and lights up an optional feature when a `leaderboard` addon is present.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import bundle from '@bedrock-core/generated/i18n';
import { createI18n } from '@bedrock-core/i18n';
import guides from '@bedrock-core/generated/guides';
import { configDef, setupShop } from './example';

// The addon's typed verbs over its resources (packs/data/i18n). Creating the instance
// also registers it as the default translation source for any UI this addon renders.
const i18n = createI18n(bundle);

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys — typed through key(), generated into
// this addon's .lang by the i18n filter; UIs localize them per player language. The
// i18n bundle and guide manifest ride along as optional fields; the typed config accessors register() returns are unused here — Shop only
// exposes its config to the UI and to cross-addon `core.config.of()` readers.
core.register({
  creator: 'drav0011',
  pack: 'shop',
  packName: i18n.key($ => $.meta.name),
  creatorName: i18n.key($ => $.meta.creator),
  version: '1.0.0',
  description: i18n.key($ => $.meta.description),
  icon: 'textures/ui/shop/icon',
  thumbnail: 'textures/ui/shop/thumbnail',
  dependencies: ['drav0011_economy'],
  optionalDependencies: ['drav0011_leaderboard'],
  translations: bundle,
  guide: guides,
  config: configDef,
});

setupShop();
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
