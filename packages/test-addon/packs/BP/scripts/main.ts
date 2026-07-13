/**
 * Test addon "Economy" — a reference bedrock-core addon and one half of the cross-addon
 * example (the other half is `test-addon-2`, "Shop"). It registers with the runtime, serves
 * balances over RPC, shares + persists its own state, and ships GameTests.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import translationKeys from '@bedrock-core/generated/translation-keys';
import guides from '@bedrock-core/generated/guides';
import { setupEconomy } from './example';
import './tests';

// register() brings the addon online — no separate start(). Display fields are
// translation keys shipped in this addon's RP (texts/en_US.lang); UIs localize
// them per player language, and Bedrock falls back to the literal string when
// no .lang entry matches.
core.register({
  creator: 'drav0011',
  namespace: 'bc_economy',
  name: 'drav0011.bc_economy.name',
  creatorName: 'drav0011.bc_economy.creator',
  version: '1.0.0',
  description: 'drav0011.bc_economy.description',
});
// Publish this addon's translation keys (by locale) so other addons' UIs (e.g. the
// Shop config screen listing every registered addon) can resolve and measure our keys.
core.translations.provide(translationKeys);
// Register this addon's guide from the MDX manifest compiled by the guides filter.
// The alternative is a custom JSX guide: core.guide(() => <MyGuide/>).
core.guide(guides);
setupEconomy();
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
