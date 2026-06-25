/**
 * The "Economy" example behavior: serve balances over RPC, share state, and persist its own
 * namespace to its own dynamic properties (persistence is the addon's job, not sync's).
 */
import { core } from '@bedrock-core/server-runtime';
import { system, world } from '@minecraft/server';

const SAVE_KEY = 'bc:economy:state';

export function setupEconomy(): void {
  // RPC + registry wiring is bus/in-memory only, so it's safe during early script execution.
  // Register the handler now so it's ready the moment a peer asks.
  core.rpc.onRequest('getBalance', params => {
    const { player } = params as { player: string };
    const balance = core.state.get(`balance.${player}`);

    return typeof balance === 'number' ? balance : 0;
  });

  core.registry.onRegister(addon => console.warn(`[economy] saw ${addon.id} (${addon.name})`));

  // Dynamic properties can't be touched during early execution — defer to the first tick.
  system.run(() => {
    // Restore our namespace from our own dynamic properties, then re-publish it.
    const saved = world.getDynamicProperty(SAVE_KEY);
    if (typeof saved === 'string') {
      try {
        const data = JSON.parse(saved) as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) core.state.set(key, value);
      } catch {
        console.warn('[economy] could not parse saved state');
      }
    }

    // Persist our namespace whenever it changes (including writes from other addons).
    core.state.onChange(change => {
      if (change.ns !== core.namespace) return;
      world.setDynamicProperty(SAVE_KEY, JSON.stringify(core.state.getNamespace()));
    });

    core.state.set('currency', 'gold');
    console.warn(`[economy] ready as ${core.id}`);
  });
}
