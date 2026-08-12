/**
 * Economy addon — exercises every config feature:
 *   server scope   : get / patch / set / onChange at root, group and leaf
 *   dimension scope: per-dim get/patch/set, onChange
 *   player scope   : per-player get/patch, onChange on join
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
    core.state.onChange((change) => {
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

    // patch — deep merge, only touched keys change
    config.server.patch({ economy: { startingBalance: 150 } });

    // set — full replace (all keys must be provided)
    config.server.set({
      economy: { startingBalance: 100, maxBalance: 99999, currency: 'emerald', allowNegative: false },
      display: { prefix: '', suffix: ' em', showInChat: true },
    });

    // Dimension scope: per-dimension override (unset keys fall back to the schema default)
    const nether = world.getDimension('nether');

    config.dimension.patch(nether, { taxRate: 0.25, tradingEnabled: false });
  });

  // ─── Player lifecycle: per-player config on join ──────────────────────────

  world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
    if (!initialSpawn) { return; }

    // Read effective config: per-player override → schema default
    const playerCfg = config.player.get(player);

    // Per-player patch
    config.player.patch(player, { notes: `${player.name} joined` });

    if (playerCfg.notify.onLogin) {
      player.sendMessage(`Balance: 0${config.server.get().display.suffix}`);
    }
  });
}
