/**
 * Test addon "Economy" — a reference bedrock-core addon and one half of the cross-addon
 * example (the other half is `test-addon-2`, "Shop"). It registers with the runtime, serves
 * balances over RPC, declares a shared shape every realm mirrors, keeps balances as documents,
 * and ships GameTests.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import { manifest } from './addon';
import { configDef, eventsDef, setupEconomy, sharedDef } from './example';

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys — typed through key(), generated into
// this addon's .lang by the i18n filter; UIs localize them per player language.
// register() returns the typed accessors of everything declared, one key each:
// `config`, `shared` and `events`.
const declared = core.register({
  manifest,
  config: configDef,
  shared: sharedDef,
  events: eventsDef,
});

setupEconomy(declared);
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
