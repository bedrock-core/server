/**
 * The "Shop" example behavior: react to the Economy addon, call an endpoint it serves, and toggle
 * an optional feature based on whether a `leaderboard` addon is installed.
 *
 * The config schema (server-scope pricing and player-scope preferences) is declared via the
 * `config` field of `core.register()` in main.ts.
 */
import { core } from '@bedrock-core/server-runtime';

// In a real project this interface lives in the economy addon's published types package
// (e.g. `@drav0011/economy-types`) and you install it as a devDependency. It is what Economy's
// rpc handlers answer to; the typed client below is built from it.
interface EconomyApi {
  balance(params: { playerId: string; actorId?: string }): { gold: number; lastSeen: number } | undefined;
}

export const configDef = {
  server: {
    pricing: {
      $label: 'Pricing',
      $description: 'What a purchase costs and whether the shop is open at all.',
      taxRate: { type: 'number', default: 0.05, min: 0, max: 1, step: 0.01, label: 'Tax Rate', description: 'Tax applied to all purchases' },
      currency: { type: 'enum', default: 'emerald', options: ['emerald', 'gold', 'diamond'] as const, label: 'Currency' },
      shopEnabled: { type: 'boolean', default: true, label: 'Shop Enabled' },
    },
    bannedItems: { type: 'list' as const, itemType: 'string' as const, maxItems: 50, default: [] as const, label: 'Banned Items', description: 'Item IDs that cannot be sold' },
  },
  player: {
    allowGifts: { type: 'boolean', default: true, label: 'Allow Gifts' },
    displayCurrency: { type: 'enum', default: 'symbol', options: ['symbol', 'name', 'both'] as const, label: 'Currency Display' },
  },
} as const;

/** Published in a types package (e.g. `@drav0011/shop-types`) so consumers get typed access. */
export type ShopConfigDef = typeof configDef;

export function setupShop(): void {
  // Once our required dependency (economy) is present, ask it for a balance.
  core.registry.onDependenciesSatisfied(() => {
    const economy = core.registry.get('drav0011_economy');

    if (!economy) {
      return;
    }

    const economyApi = core.rpc.typed<EconomyApi>(economy.id);

    // No actor: the shop asking for its own reasons, which the owner's rule leaves open.
    economyApi.balance({ playerId: 'steve' })
      .catch((error: unknown) => console.warn(`[shop] balance request failed: ${String(error)}`));
  });
}
