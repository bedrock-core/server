/**
 * Test addon "Economy" — a reference bedrock-core addon and one half of the cross-addon
 * example (the other half is `test-addon-2`, "Shop"). It registers with the runtime, serves
 * balances over RPC, shares + persists its own state, and ships GameTests.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import bundle from '@bedrock-core/generated/i18n';
import { createI18n } from '@bedrock-core/i18n';
import guides from '@bedrock-core/generated/guides';
import { configDef, setupEconomy } from './example';
import './tests';

// The addon's typed verbs over its resources (packs/data/i18n). Creating the instance
// also registers it as the default translation source for any UI this addon renders.
const i18n = createI18n(bundle);

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys — typed through key(), generated into
// this addon's .lang by the i18n filter; UIs localize them per player language. The
// i18n bundle and guide manifest ride along as optional fields; register() returns the typed config accessors.
const config = core.register({
  creator: 'drav0011',
  pack: 'economy',
  packName: i18n.key($ => $.meta.name),
  creatorName: i18n.key($ => $.meta.creator),
  version: '1.0.0',
  description: i18n.key($ => $.meta.description),
  translations: bundle,
  guide: guides,
  config: configDef,
});

setupEconomy(config);
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
