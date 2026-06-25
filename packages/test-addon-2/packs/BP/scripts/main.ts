/**
 * Test addon "Shop" — the second half of the cross-addon example. It shares a creator but a
 * different namespace from "Economy"; it depends on the `economy` namespace, calls Economy
 * over RPC, and lights up an optional feature when a `leaderboard` addon is present.
 */
import { core } from '@bedrock-core/server-runtime';
import { setupShop } from './example';

// register() brings the addon online — no separate start().
core.register({
  creator: 'drav0011',
  namespace: 'bc_shop',
  name: 'Shop',
  version: '1.0.0',
  description: 'Sells items for currency',
  dependencies: ['drav0011:bc_economy'],
  optionalDependencies: ['drav0011:bc_leaderboard'],
});
setupShop();
