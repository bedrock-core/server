/**
 * Test addon "Economy" — a reference bedrock-core addon and one half of the cross-addon
 * example (the other half is `test-addon-2`, "Shop"). It registers with the runtime, serves
 * balances over RPC, shares + persists its own state, and ships GameTests.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import translationKeys from '@bedrock-core/generated/translation-keys';
import guides from '@bedrock-core/generated/guides';
import { configDef, setupEconomy } from './example';
import './tests';

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys shipped in this addon's RP
// (texts/en_US.lang); UIs localize them per player language, and Bedrock falls back to
// the literal string when no .lang entry matches. The generated translations and guide
// manifest (from the Regolith filters) and the config schema ride along as optional
// fields; register() returns the typed config accessors.
const config = core.register({
  creator: 'drav0011',
  pack: 'bc_economy',
  packName: 'drav0011.bc_economy.name',
  creatorName: 'drav0011.bc_economy.creator',
  version: '1.0.0',
  description: 'drav0011.bc_economy.description',
  translations: translationKeys,
  guide: guides,
  config: configDef,
});

setupEconomy(config);
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
