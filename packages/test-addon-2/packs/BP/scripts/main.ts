/**
 * Test addon "Shop" — the second half of the cross-addon example. It shares a creator but a
 * different namespace from "Economy"; it depends on the `economy` namespace, calls Economy
 * over RPC, and lights up an optional feature when a `leaderboard` addon is present.
 */
import { core } from '@bedrock-core/server-runtime';
import { ui } from '@bedrock-core/config';
import { manifest } from './addon';
import { setupCrafting } from './container/crafting';
import { configDef, setupShop } from './example';

// register() declares everything in one call and brings the addon online — no separate
// start(). Display fields are translation keys, generated into this addon's .lang by the
// i18n filter, and localized per player. The typed accessors it returns are unused here:
// Shop exposes its config to the UI and to cross-addon `core.config.of()` readers only.
core.register({
  manifest: { ...manifest, dependencies: ['drav0011_economy'], optionalDependencies: ['drav0011_leaderboard'] },
  config: configDef,
});

setupShop();
// The Shop's crafting table: a compiled container screen, served over an entity.
setupCrafting();
// Mount the shared config UI — command registration is first-wins across addons, so with
// several bedrock-core addons installed exactly one realm serves the UI for all of them.
ui(core);
