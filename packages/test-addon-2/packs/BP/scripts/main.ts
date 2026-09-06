/**
 * Test addon "Shop" — the second half of the cross-addon example. It shares a creator but a
 * different namespace from "Economy"; it depends on the `economy` namespace, calls Economy
 * over RPC, and lights up an optional feature when a `leaderboard` addon is present.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import { addonPageReference } from '@bedrock-core/config/compiled';
import bundle from '@bedrock-core/generated/i18n';
import guides from '@bedrock-core/generated/guides';
import { guideReference } from '@bedrock-core/guides';
import { manifest } from './addon';
import { setupCrafting } from './container/crafting';
import { configDef, setupShop } from './example';
import AddonPage from './screens/addon.screen';
// The compiled screens registered by the module the ui-compile filter generates.
import '@bedrock-core/generated/ui';

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys — typed through key(), generated into
// this addon's .lang by the i18n filter; UIs localize them per player language. The
// i18n bundle and guide manifest ride along as optional fields; the typed config accessors register() returns are unused here — Shop only
// exposes its config to the UI and to cross-addon `core.config.of()` readers.
core.register({
  ...manifest,
  dependencies: ['drav0011_economy'],
  optionalDependencies: ['drav0011_leaderboard'],
  translations: bundle,
  guide: guides,
  // The same guide as compiled screens, reduced to what the host needs to
  // present it with native forms: every client already holds the pages.
  guideReference: guideReference('drav0011_shop'),
  // This addon's page in the shared addon list, baked in its own pack.
  page: addonPageReference(AddonPage),
  config: configDef,
});

setupShop();
// The Shop's crafting table: a compiled container screen, served over an entity.
setupCrafting();
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
