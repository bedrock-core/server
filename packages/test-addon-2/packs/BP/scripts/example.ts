/**
 * The "Shop" example behavior: react to the Economy addon, call it over RPC, and toggle an
 * optional feature based on whether a `leaderboard` addon is installed.
 */
import { core } from '@bedrock-core/server-runtime';

export function setupShop(): void {
  // Optional, togglable feature: only active while the leaderboard addon is present.
  core.feature('leaderboard-sync', {
    condition: r => r.has('drav0011:bc_leaderboard'),
    onEnable: () => console.warn('[shop] leaderboard online — score sync enabled'),
    onDisable: () => console.warn('[shop] leaderboard offline — score sync disabled'),
  });

  // Once our required dependency (economy) is present, ask it for a balance. 
  core.registry.onDependenciesSatisfied(() => {
    const economy = core.registry.get('drav0011:bc_economy');
    if (!economy) return;
    console.warn(`[shop] economy ready: ${economy.id}`);
    core.rpc.request(economy.id, 'getBalance', { player: 'Steve' })
      .then(balance => console.warn(`[shop] Steve's balance = ${String(balance)}`))
      .catch((error: unknown) => console.warn(`[shop] balance request failed: ${String(error)}`));
  });

  console.warn(`[shop] ready as ${core.id}`);
}
