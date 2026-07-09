/**
 * Economy addon — exercises every config feature:
 *   server scope   : get / patch / set / onChange at root, group and leaf
 *   dimension scope: per-dim get/patch/set, defaults, onChange
 *   player scope   : per-player get/patch, defaults, onChange on join
 *   cross-addon    : subscribe to Shop's config (test-addon-2)
 *   types          : export EconomyConfigDef so consumers can type cross-addon reads
 */
import { core } from '@bedrock-core/server-runtime';
import { system, world } from '@minecraft/server';

// ─── State persistence ────────────────────────────────────────────────────────

const SAVE_KEY = 'bc:economy:state';

// ─── RPC ─────────────────────────────────────────────────────────────────────

export interface EconomyRPC { getBalance(params: { player: string }): number }

// ─── Config schema ────────────────────────────────────────────────────────────

/**
 * Export this type (e.g. from `@drav0011/bc-economy-types`) so consumers can
 * get fully-typed access via `core.config.of<EconomyConfigDef>(...)`.
 */
const configDef = {
  server: {
    economy: {
      startingBalance: { type: 'number' as const, default: 100, min: 0, max: 10000, step: 1, label: 'Starting Balance', widget: 'number-input' as const },
      maxBalance: { type: 'number' as const, default: 99999, min: 1, max: 999999, step: 1, label: 'Max Balance', widget: 'number-input' as const },
      currency: { type: 'enum' as const, default: 'emerald' as const, options: ['emerald', 'gold', 'diamond'] as const, label: 'Currency' },
      allowNegative: { type: 'boolean' as const, default: false, label: 'Allow Negative Balance', widget: 'toggle' as const },
    },
    display: {
      prefix: { type: 'string' as const, default: '', maxLength: 8, label: 'Balance Prefix', widget: 'input' as const },
      suffix: { type: 'string' as const, default: ' em', maxLength: 8, label: 'Balance Suffix', widget: 'input' as const },
      showInChat: { type: 'boolean' as const, default: true, label: 'Show In Chat', widget: 'checkbox' as const },
    },
  },
  dimension: {
    taxRate: { type: 'number' as const, default: 0.05, min: 0, max: 1, step: 0.01, label: 'Tax Rate', widget: 'slider' as const },
    tradingEnabled: { type: 'boolean' as const, default: true, label: 'Trading Enabled', widget: 'toggle' as const },
  },
  player: {
    notify: {
      onTransaction: { type: 'boolean' as const, default: true, label: 'Notify on Transaction', widget: 'toggle' as const },
      onLogin: { type: 'boolean' as const, default: true, label: 'Notify on Login', widget: 'toggle' as const },
    },
    displayFormat: { type: 'enum' as const, default: 'symbol' as const, options: ['symbol', 'full', 'short'] as const, label: 'Display Format' },
    notes: { type: 'string' as const, default: '', maxLength: 100, label: 'Player Notes', widget: 'textarea' as const },
  },
} as const;

export type EconomyConfigDef = typeof configDef;

// ─── Setup ────────────────────────────────────────────────────────────────────

export function setupEconomy(): void {
  // ─── RPC ──────────────────────────────────────────────────────────────────

  core.rpc.serve<EconomyRPC>({
    getBalance: ({ player }) => {
      const balance = core.state.get(`balance.${player}`);

      return typeof balance === 'number' ? balance : 0;
    },
  });

  // ─── Config ───────────────────────────────────────────────────────────────

  const config = core.config.define(configDef);

  // ─── Deferred setup (requires tick ≥ 1 for DP access) ────────────────────

  system.run(() => {
    // Restore state from dynamic properties
    const saved = world.getDynamicProperty(SAVE_KEY);

    if (typeof saved === 'string') {
      try {
        const data = JSON.parse(saved) as Record<string, unknown>;

        for (const [key, value] of Object.entries(data)) { core.state.set(key, value); }
      } catch {
        console.warn('[economy] could not parse saved state');
      }
    }

    core.state.onChange((change) => {
      if (change.ns !== core.namespace) { return; }

      world.setDynamicProperty(SAVE_KEY, JSON.stringify(core.state.getNamespace()));
    });
    core.state.set('currency', 'gold');

    // patch — deep merge, only touched keys change
    config.server.patch({ economy: { startingBalance: 150 } });

    // set — full replace (all keys must be provided)
    config.server.set({
      economy: { startingBalance: 100, maxBalance: 99999, currency: 'emerald', allowNegative: false },
      display: { prefix: '', suffix: ' em', showInChat: true },
    });

    // Dimension scope: defaults + per-dimension overrides
    const nether = world.getDimension('nether');

    // Global default — applies to all dimensions without a per-dim override
    config.dimension.patchDefault({ taxRate: 0.10 });

    // Per-dimension override
    config.dimension.patch(nether, { taxRate: 0.25, tradingEnabled: false });

    // setDefault — full replace of the dimension default
    config.dimension.setDefault({ taxRate: 0.05, tradingEnabled: true });

    // Player scope: set defaults (per-player values are loaded on join)
    config.player.patchDefault({ notify: { onTransaction: true, onLogin: false } });
  });

  // ─── Player lifecycle: per-player config on join ──────────────────────────

  world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
    if (!initialSpawn) { return; }

    // Read effective config: per-player override → default → schema default
    const playerCfg = config.player.get(player);

    // Per-player patch
    config.player.patch(player, { notes: `${player.name} joined` });

    if (playerCfg.notify.onLogin) {
      player.sendMessage(`Balance: 0${config.server.get().display.suffix}`);
    }
  });
}
