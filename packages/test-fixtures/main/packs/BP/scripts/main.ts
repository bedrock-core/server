/**
 * The fixture registers with the runtime and registers the one block component its block type
 * names. The GameTests in `./tests` build their own runtimes; this registration exists so `core`
 * is live for the tests that read it, and so the peer pack has a realm to be discovered from.
 */
import { system } from '@minecraft/server';
import { blockCleanup } from '@bedrock-core/db/minecraft';
import { core } from '@bedrock-core/server-runtime';
import { manifest } from './addon';

core.register({ manifest });

// `blocks/db_probe.json` names this component, and the engine removes a block type whose custom
// component nobody registered — so this ships with the pack rather than with the tests. It keeps
// `core.db`'s block indexes honest: every removal drops the block's index entry.
system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent('core_fixture:db_cleanup', blockCleanup(core.db));
});
