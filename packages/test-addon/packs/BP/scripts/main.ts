/**
 * Test addon "Economy" — a reference bedrock-core addon and one half of the cross-addon
 * example (the other half is `test-addon-2`, "Shop"). It registers with the runtime, serves
 * balances over RPC, shares + persists its own state, and ships GameTests.
 */
import { core } from '@bedrock-core/server-runtime';
import { setupEconomy } from './example';
import './tests';

// register() brings the addon online — no separate start().
core.register({
  creator: 'drav0011',
  namespace: 'bc_economy',
  name: 'Economy',
  version: '1.0.0',
  description: 'Provides player balances to other addons',
});
setupEconomy();
