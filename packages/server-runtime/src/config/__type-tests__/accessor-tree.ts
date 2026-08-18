/**
 * Type-level tests for the config accessor tree. There is no runtime here — `tsc` failing IS
 * the failure, and this package is checked with `noEmit`, so the file costs a compile and
 * nothing else.
 *
 * It exists because group metadata (`$label` / `$description`) broke every one of these at once
 * and nothing caught it. A named group holds a `string` beside its children, so it stops being
 * a `Record<string, SchemaNode>` — and the inference helpers that tested for exactly that
 * collapsed the group, and everything beneath it, to `never`. The accessor tree still COMPILED;
 * it just typed `config.server.economy.balances.start.get()` as an error rather than a number.
 *
 * So: assert the shapes, and assert that `$label` is NOT among them.
 */
import type { Config } from '../../index';

/**
 * Exported so it counts as used — it is referenced only through `typeof`, and a plain const in
 * that position reads as dead code to the unused-vars rule. Exporting also leaves the fixture
 * reusable if more type tests land beside this one.
 */
export const SCHEMA = {
  server: {
    economy: {
      $label: 'Economy',
      $description: 'Named group, two levels of children under it.',
      balances: {
        $label: 'Balances',
        start: { type: 'number' as const, default: 1, min: 0, max: 9, label: 'Start' },
      },
      // Unnamed group beside a named one — both must behave identically.
      currency: {
        kind: { type: 'enum' as const, default: 'a' as const, options: ['a', 'b'] as const, label: 'Kind' },
      },
    },
    picks: { type: 'multiselect' as const, options: ['x', 'y'] as const, default: ['x'] as const, label: 'Picks' },
    tags: { type: 'list' as const, itemType: 'string' as const, default: [] as const, label: 'Tags' },
  },
} as const;

declare const config: Config<typeof SCHEMA>;

// ─── Leaves narrow to their real types, at any depth ──────────────────────────

export const start: number = config.server.economy.balances.start.get();
export const kind: 'a' | 'b' = config.server.economy.currency.kind.get();

/** Both array-valued types read back as arrays, not as the JSON they are stored as. */
export const picks: string[] = config.server.picks.get();
export const tags: string[] = config.server.tags.get();

// ─── A group yields its nested value shape, WITHOUT its own metadata ──────────

const economy = config.server.economy.get();

export const nested: number = economy.balances.start;

// @ts-expect-error -- $label describes the group; it is never part of the value object
export const leaked = economy.$label;

// ─── Writes exclude metadata too ──────────────────────────────────────────────

config.server.economy.patch({ balances: { start: 2 } });

// @ts-expect-error -- $label is not a setting, so there is nothing to patch
config.server.economy.patch({ $label: 'nope' });

// ─── Dot-paths skip metadata and reach the deep leaf ──────────────────────────

config.server.subscribe('economy.balances.start', (next: number) => void next);

// @ts-expect-error -- '$label' is not a dot-path
config.server.subscribe('economy.$label', (next: string) => void next);
