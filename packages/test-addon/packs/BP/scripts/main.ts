/**
 * Test addon "Economy" — a reference bedrock-core addon and one half of the cross-addon
 * example (the other half is `test-addon-2`, "Shop"). It registers with the runtime, serves
 * balances over RPC, declares a shared shape every realm mirrors, keeps balances as documents,
 * and ships GameTests.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import { addonPageReference } from '@bedrock-core/config/compiled';
import bundle from '@bedrock-core/generated/i18n';
import guides from '@bedrock-core/generated/guides';
import { guideReference } from '@bedrock-core/guides';
import { manifest } from './addon';
import { configDef, eventsDef, setupEconomy, sharedDef } from './example';
import AddonPage from './screens/addon.screen';
// The compiled screens — the guide's pages among them — registered by the
// module the ui-compile filter generates.
import '@bedrock-core/generated/ui';

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys — typed through key(), generated into
// this addon's .lang by the i18n filter; UIs localize them per player language. The
// i18n bundle and guide manifest ride along as optional fields; register() returns the typed
// accessors of everything declared, one key each: `config`, `shared` and `events`.
const declared = core.register({
  manifest,
  translations: bundle,
  guide: guides,
  // The same guide as compiled screens, reduced to what the host needs to
  // present it with native forms: every client already holds the pages.
  guideReference: guideReference('drav0011_economy'),
  // This addon's page in the shared addon list, baked in its own pack; the
  // host draws it from the reference alone.
  page: addonPageReference(AddonPage),
  config: configDef,
  shared: sharedDef,
  events: eventsDef,
});

setupEconomy(declared);
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
