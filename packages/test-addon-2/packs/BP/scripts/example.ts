/**
 * The "Shop" example behavior: react to the Economy addon, call it over RPC, and toggle an
 * optional feature based on whether a `leaderboard` addon is installed.
 *
 * Also demonstrates core.config.define() — server-scope pricing and player-scope preferences.
 */
import { core } from '@bedrock-core/server-runtime';

// In a real project this interface lives in the economy addon's published types package
// (e.g. `@drav0011/bc-economy-types`) and you install it as a devDependency.
interface EconomyRPC { getBalance(params: { player: string }): number }

const configDef = {
  server: {
    pricing: {
      taxRate: { type: 'number', default: 0.05, min: 0, max: 1, step: 0.01, label: 'Tax Rate', description: 'Tax applied to all purchases' },
      currency: { type: 'enum', default: 'emerald', options: ['emerald', 'gold', 'diamond'] as const, label: 'Currency', widget: 'dropdown' },
      shopEnabled: { type: 'boolean', default: true, label: 'Shop Enabled' },
    },
    bannedItems: { type: 'list' as const, itemType: 'string' as const, maxItems: 50, default: [] as const, label: 'Banned Items', description: 'Item IDs that cannot be sold' },
  },
  player: {
    allowGifts: { type: 'boolean', default: true, label: 'Allow Gifts' },
    displayCurrency: { type: 'enum', default: 'symbol', options: ['symbol', 'name', 'both'] as const, label: 'Currency Display', widget: 'toggle-buttons' },
  },
} as const;

/** Published in a types package (e.g. `@drav0011/bc-shop-types`) so consumers get typed access. */
export type ShopConfigDef = typeof configDef;

export function setupShop(): void {
  const config = core.config.define(configDef);

  // Optional, togglable feature: only active while the leaderboard addon is present.
  core.feature('leaderboard-sync', {
    condition: ctx => ctx.registry.has('drav0011:bc_leaderboard'),
    onEnable: () => console.warn('[shop] leaderboard online — score sync enabled'),
    onDisable: () => console.warn('[shop] leaderboard offline — score sync disabled'),
  });

  // Log current server config after tick 1 (values loaded from dynamic properties).
  core.registry.onDependenciesSatisfied(() => {
    const cfg = config.server.get();

    console.warn(`[shop] taxRate = ${String(cfg.pricing.taxRate)}`);
    console.warn(`[shop] currency = ${String(cfg.pricing.currency)}`);
  });

  // React to server-scope config changes (e.g. written by the UI addon via RPC).
  config.server.onChange('pricing.taxRate', (next, prev) => {
    console.warn(`[shop] taxRate changed: ${String(prev)} → ${String(next)}`);
  });

  // Once our required dependency (economy) is present, ask it for a balance.
  core.registry.onDependenciesSatisfied(() => {
    const economy = core.registry.get('drav0011:bc_economy');

    if (!economy) {
      return;
    }

    console.warn(`[shop] economy ready: ${economy.id}`);
    const economyRpc = core.rpc.typed<EconomyRPC>(economy.id);

    economyRpc.getBalance({ player: 'Steve' })
      .then(balance => console.warn(`[shop] Steve's balance = ${String(balance)}`))
      .catch((error: unknown) => console.warn(`[shop] balance request failed: ${String(error)}`));
  });

  console.warn(`[shop] ready as ${core.id}`);
}
