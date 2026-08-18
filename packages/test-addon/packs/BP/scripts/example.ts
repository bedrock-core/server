/**
 * Economy addon — exercises every config feature:
 *   accessor tree  : config.server.economy.currency.kind.get() / .set() / .subscribe() at every depth
 *   server scope   : get / patch / set / subscribe at root, group and leaf
 *   dimension scope: per-dim for(dim), get/patch/set
 *   player scope   : per-player for(player), subscribe on join
 *   cross-addon    : subscribe to Shop's config (test-addon-2)
 *   types          : export EconomyConfigDef so consumers can type cross-addon reads
 *
 * The schema below is also the UI's reference case — see the note above `configDef`.
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
 *
 * It is deliberately shaped to hit every branch the config UI has, so opening
 * `/drav0011_economy:config` walks through all of them:
 *
 *   server                    every child is a group → SCREEN OF BUTTONS
 *     economy                 both children are groups → ANOTHER SCREEN OF BUTTONS
 *       balances              holds settings → FORM (wide-range number → text input,
 *                             narrow-range number → slider, boolean → toggle)
 *       currency              FORM (3-option enum → inline toggle buttons)
 *     display                 FORM, with `advanced` drawn INLINE beneath it — a nested
 *                             group on a form level has nowhere to navigate to
 *                             (7-option enum → dropdown, past the inline cutoff)
 *     moderation              nothing but lists → SCREEN OF BUTTONS, one row per list,
 *                             each opening the list editor (string items, and enum
 *                             items which offer only what is not already in)
 *   dimension                 FORM with a list stranded on it → the list falls back to
 *                             showing its items and the command that edits them
 *   player                    FORM (multiselect → checkbox group; `notify` inline)
 *
 * `$label` / `$description` name a group; leave them off and the UI derives a title from
 * the key (`display.advanced` below has no `$label`, so it reads as "Advanced").
 */
export const configDef = {
  server: {
    economy: {
      $label: 'Economy',
      $description: 'Balances, currency and what players may go negative to.',
      balances: {
        $label: 'Balances',
        $description: 'What players start with and how far they can go.',
        startingBalance: { type: 'number' as const, default: 100, min: 0, max: 10000, step: 1, label: 'Starting Balance', description: 'Given to a player the first time they join.' },
        dailyBonus: { type: 'number' as const, default: 5, min: 0, max: 50, step: 1, label: 'Daily Bonus', description: 'Paid out once per day. Narrow range, so this one is a slider.' },
        maxBalance: { type: 'number' as const, default: 99999, min: 1, max: 999999, step: 1, label: 'Max Balance' },
        allowNegative: { type: 'boolean' as const, default: false, label: 'Allow Negative Balance' },
      },
      currency: {
        $label: 'Currency',
        kind: { type: 'enum' as const, default: 'emerald' as const, options: ['emerald', 'gold', 'diamond'] as const, label: 'Currency', description: 'Three options, so it draws as inline segments.' },
        symbol: { type: 'string' as const, default: 'em', maxLength: 4, label: 'Currency Symbol' },
      },
    },
    display: {
      $label: 'Display',
      $description: 'How balances are written wherever they appear.',
      prefix: { type: 'string' as const, default: '', maxLength: 8, label: 'Balance Prefix' },
      suffix: { type: 'string' as const, default: ' em', maxLength: 8, label: 'Balance Suffix' },
      showInChat: { type: 'boolean' as const, default: true, label: 'Show In Chat' },
      advanced: {
        // No `$label` on purpose — the UI falls back to the key.
        $description: 'Nested under a level that has settings of its own, so it is drawn inline rather than behind a button.',
        theme: { type: 'enum' as const, default: 'classic' as const, options: ['classic', 'compact', 'bold', 'mono', 'high_contrast', 'retro', 'minimal'] as const, label: 'Theme', description: 'Seven options, past the inline cutoff, so it draws as a dropdown.' },
        decimals: { type: 'number' as const, default: 2, min: 0, max: 4, step: 1, label: 'Decimal Places' },
      },
    },
    moderation: {
      $label: 'Moderation',
      $description: 'Nothing here is a form field, so this level is a list of buttons.',
      blockedItems: { type: 'list' as const, itemType: 'string' as const, maxItems: 8, default: [] as const, label: 'Blocked Items', description: 'Item IDs that may never be traded. Typed in, so the editor asks for text.' },
      watchedDimensions: { type: 'list' as const, itemType: 'enum' as const, options: ['overworld', 'nether', 'the_end'] as const, default: ['nether'] as const, label: 'Watched Dimensions', description: 'Picked from a fixed set, so the editor offers only what is not already in.' },
    },
  },
  dimension: {
    taxRate: { type: 'number' as const, default: 0.05, min: 0, max: 1, step: 0.01, label: 'Tax Rate' },
    tradingEnabled: { type: 'boolean' as const, default: true, label: 'Trading Enabled' },
    blockedTrades: { type: 'list' as const, itemType: 'string' as const, maxItems: 4, default: [] as const, label: 'Blocked Trades', description: 'On a level that HAS form fields, so this one has no button to offer — it shows its items and the command instead.' },
  },
  player: {
    notify: {
      $label: 'Notifications',
      $description: 'Drawn inline: this level has settings of its own, so there is nothing to navigate to.',
      onTransaction: { type: 'boolean' as const, default: true, label: 'Notify on Transaction' },
      onLogin: { type: 'boolean' as const, default: true, label: 'Notify on Login' },
    },
    displayFormat: { type: 'enum' as const, default: 'symbol' as const, options: ['symbol', 'full', 'short'] as const, label: 'Display Format' },
    features: { type: 'multiselect' as const, options: ['tips', 'sounds', 'popups'] as const, default: ['tips'] as const, label: 'Enabled Features', description: 'Any number of a fixed set — one checkbox per option.' },
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

    // Accessor tree — every node carries its own verbs, leaf or group, at any depth
    config.server.economy.currency.kind.set('gold');
    config.server.economy.balances.startingBalance.set(120);
    config.server.display.patch({ suffix: ' g' });

    config.server.economy.currency.kind.subscribe((next, prev) => {
      console.warn(`[economy] currency ${String(prev)} → ${next}`);
    });
    // Subscribing at a GROUP fires for any leaf beneath it, however deep.
    config.server.economy.subscribe((economy) => {
      console.warn(`[economy] group changed, balance now ${String(economy.balances.startingBalance)}`);
    });

    // A list is patched like any other leaf — it is one flat key holding the whole array.
    config.server.moderation.blockedItems.set(['minecraft:bedrock', 'minecraft:barrier']);

    // patch — deep merge, only touched keys change
    config.server.patch({ economy: { balances: { startingBalance: 150 } } });

    // set — full replace (all keys must be provided)
    config.server.set({
      economy: {
        balances: { startingBalance: 100, dailyBonus: 5, maxBalance: 99999, allowNegative: false },
        currency: { kind: 'emerald', symbol: 'em' },
      },
      display: {
        prefix: '', suffix: ' em', showInChat: true,
        advanced: { theme: 'classic', decimals: 2 },
      },
      moderation: { blockedItems: ['minecraft:bedrock'], watchedDimensions: ['nether'] },
    });

    // Dimension scope: per-dimension override (unset keys fall back to the schema default)
    const nether = world.getDimension('nether');

    config.dimension.for(nether).taxRate.set(0.25);
    config.dimension.patch(nether, { tradingEnabled: false, blockedTrades: ['minecraft:elytra'] });
  });

  // ─── Player lifecycle: per-player config on join ──────────────────────────

  world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
    if (!initialSpawn) { return; }

    // The player's own accessor tree — same shape as the server scope past `for()`
    const playerCfg = config.player.for(player);

    // Per-player write, at the leaf
    playerCfg.notes.set(`${player.name} joined`);
    // A multiselect reads back as the array it is.
    playerCfg.features.set(['tips', 'sounds']);

    playerCfg.notify.onLogin.subscribe((next) => {
      player.sendMessage(`Login notifications ${next ? 'on' : 'off'}`);
    });

    if (playerCfg.notify.onLogin.get()) {
      player.sendMessage(`Balance: 0${config.server.display.suffix.get()}`);
    }
  });
}
