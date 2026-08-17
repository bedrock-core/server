/**
 * Economy addon — exercises every config feature:
 *   accessor tree  : config.server.economy.currency.get() / .set() / .subscribe() at every depth
 *   server scope   : get / patch / set / subscribe at root, group and leaf
 *   dimension scope: per-dim for(dim), get/patch/set
 *   player scope   : per-player for(player), subscribe on join
 *   cross-addon    : subscribe to Shop's config (test-addon-2)
 *   types          : export EconomyConfigDef so consumers can type cross-addon reads
 */
import { core } from '@bedrock-core/server-runtime';
import type { Config } from '@bedrock-core/server-runtime';
import { system, world } from '@minecraft/server';

// ─── State persistence ────────────────────────────────────────────────────────

/**
 * One dynamic property per state key, under this addon's OWN namespace — `core` belongs to the
 * framework, an addon must not squat it.
 *
 * Per key, not one blob for the whole namespace: a dynamic property string caps at 32767
 * characters, and a namespace that grows a key per player crosses that on some later write, far
 * from the code that added the key. Persisting per key also rewrites only what changed.
 */
const SAVE_PREFIX = 'drav0011:economy:';

/** Bedrock's ceiling for a string dynamic property. */
const DP_STRING_MAX = 32767;

// ─── RPC ─────────────────────────────────────────────────────────────────────

export interface EconomyRPC { getBalance(params: { player: string }): number }

// ─── Config schema ────────────────────────────────────────────────────────────

/**
 * Declared via the `config` field of `core.register()` in main.ts. Export this type
 * (e.g. from `@drav0011/economy-types`) so consumers can get fully-typed access
 * via `core.config.of<EconomyConfigDef>(...)`.
 */
export const configDef = {
  server: {
    economy: {
      startingBalance: { type: 'number' as const, default: 100, min: 0, max: 10000, step: 1, label: 'Starting Balance' },
      maxBalance: { type: 'number' as const, default: 99999, min: 1, max: 999999, step: 1, label: 'Max Balance' },
      currency: { type: 'enum' as const, default: 'emerald' as const, options: ['emerald', 'gold', 'diamond'] as const, label: 'Currency' },
      allowNegative: { type: 'boolean' as const, default: false, label: 'Allow Negative Balance' },
    },
    display: {
      prefix: { type: 'string' as const, default: '', maxLength: 8, label: 'Balance Prefix' },
      suffix: { type: 'string' as const, default: ' em', maxLength: 8, label: 'Balance Suffix' },
      showInChat: { type: 'boolean' as const, default: true, label: 'Show In Chat' },
    },
  },
  dimension: {
    taxRate: { type: 'number' as const, default: 0.05, min: 0, max: 1, step: 0.01, label: 'Tax Rate' },
    tradingEnabled: { type: 'boolean' as const, default: true, label: 'Trading Enabled' },
  },
  player: {
    notify: {
      onTransaction: { type: 'boolean' as const, default: true, label: 'Notify on Transaction' },
      onLogin: { type: 'boolean' as const, default: true, label: 'Notify on Login' },
    },
    displayFormat: { type: 'enum' as const, default: 'symbol' as const, options: ['symbol', 'full', 'short'] as const, label: 'Display Format' },
    notes: { type: 'string' as const, default: '', maxLength: 100, label: 'Player Notes' },
  },
} as const;

export type EconomyConfigDef = typeof configDef;

// ─── Setup ────────────────────────────────────────────────────────────────────

export function setupEconomy(config: Config<EconomyConfigDef>): void {
  // ─── RPC ──────────────────────────────────────────────────────────────────

  core.rpc.serve<EconomyRPC>({
    getBalance: ({ player }) => {
      const balance = core.state.get(`balance.${player}`);

      return typeof balance === 'number' ? balance : 0;
    },
  });

  // ─── Deferred setup (requires tick ≥ 1 for DP access) ────────────────────

  system.run(() => {
    // Restore state from dynamic properties, before subscribing — so replaying the saved keys
    // does not write every one of them straight back out.
    for (const dpKey of world.getDynamicPropertyIds()) {
      if (!dpKey.startsWith(SAVE_PREFIX)) { continue; }

      const saved = world.getDynamicProperty(dpKey);

      if (typeof saved !== 'string') { continue; }

      try {
        core.state.set(dpKey.slice(SAVE_PREFIX.length), JSON.parse(saved) as unknown);
      } catch {
        console.warn(`[economy] could not parse saved state '${dpKey}'`);
      }
    }

    // No namespace check: `core.state` is already scoped to this addon and hides the framework's
    // own keys, so this fires only for what the addon itself wrote.
    core.state.subscribe((change) => {
      const dpKey = `${SAVE_PREFIX}${change.key}`;

      if (change.deleted) {
        world.setDynamicProperty(dpKey, undefined);

        return;
      }

      const encoded = JSON.stringify(change.value);

      if (encoded.length > DP_STRING_MAX) {
        console.warn(`[economy] '${change.key}' is ${String(encoded.length)} chars, over the ${String(DP_STRING_MAX)} dynamic-property limit — not persisted`);

        return;
      }

      world.setDynamicProperty(dpKey, encoded);
    });
    core.state.set('currency', 'gold');

    // Accessor tree — every node carries its own verbs, leaf or group
    config.server.economy.currency.set('gold');
    config.server.economy.startingBalance.set(120);
    config.server.display.patch({ suffix: ' g' });

    config.server.economy.currency.subscribe((next, prev) => {
      console.warn(`[economy] currency ${String(prev)} → ${next}`);
    });
    config.server.economy.subscribe((economy) => {
      console.warn(`[economy] group changed, balance now ${String(economy.startingBalance)}`);
    });

    // patch — deep merge, only touched keys change
    config.server.patch({ economy: { startingBalance: 150 } });

    // set — full replace (all keys must be provided)
    config.server.set({
      economy: { startingBalance: 100, maxBalance: 99999, currency: 'emerald', allowNegative: false },
      display: { prefix: '', suffix: ' em', showInChat: true },
    });

    // Dimension scope: per-dimension override (unset keys fall back to the schema default)
    const nether = world.getDimension('nether');

    config.dimension.for(nether).taxRate.set(0.25);
    config.dimension.patch(nether, { tradingEnabled: false });
  });

  // ─── Player lifecycle: per-player config on join ──────────────────────────

  world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
    if (!initialSpawn) { return; }

    // The player's own accessor tree — same shape as the server scope past `for()`
    const playerCfg = config.player.for(player);

    // Per-player write, at the leaf
    playerCfg.notes.set(`${player.name} joined`);

    playerCfg.notify.onLogin.subscribe((next) => {
      player.sendMessage(`Login notifications ${next ? 'on' : 'off'}`);
    });

    if (playerCfg.notify.onLogin.get()) {
      player.sendMessage(`Balance: 0${config.server.display.suffix.get()}`);
    }
  });
}
