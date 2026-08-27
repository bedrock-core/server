/**
 * Payloads shared by the wire benchmarks and the wire-size report.
 *
 * The three sizes mirror the ones circulated in the community comparison of `mcbe-ipc` and
 * `@mcbe-mods/ipc`, so numbers measured here sit next to theirs without re-deriving a scale:
 * a bare string, a small record, and a real deeply-nested document.
 *
 * The 16KB fixture is a trimmed npm registry document (7 versions of `@mcbe-mods/utils`). It is
 * vendored rather than fetched so a benchmark run needs no network and cannot drift between runs.
 */
import registry from './fixtures/registry-16kb.json';

export interface Payload {

  /** Label used in bench names and report rows. */
  label: string;

  /** The value handed to `Envelope.data`. */
  value: unknown;
}

/** A small record of the shape addons actually replicate: an identity plus a few scalars. */
const SMALL_RECORD = {
  player: 'Steve',
  position: { x: 128.5, y: 64, z: -512.25 },
  inventory: ['diamond_sword', 'golden_apple', 'ender_pearl'],
  balance: 12500,
  rank: 'veteran',
  lastSeen: 1747670460000,
};

export const TINY: Payload = { label: '5B', value: 'hello' };
export const SMALL: Payload = { label: '200B', value: SMALL_RECORD };
export const LARGE: Payload = { label: '16KB', value: registry };

export const PAYLOADS: readonly Payload[] = [TINY, SMALL, LARGE];

/**
 * The burst packing actually sees: one node writing many keys in a single tick.
 *
 * Every `State.set` sends its own delta, and `broadcastOwnedSnapshots` and the reply to a
 * `state-req` both send one message per namespace from inside a loop — so these pile into one
 * node's outbound queue and leave together on the next flush. Heartbeats do not: each addon runs
 * in its own script realm with its own queue, so a world's announces are one message apiece from
 * places that can never share a batch.
 */
export function stateDeltaBurst(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    ns: 'economy',
    key: `price:${MATERIALS[i % MATERIALS.length]}`,
    value: 16 + i,
    ver: 1200 + i,
  }));
}

const MATERIALS = ['diamond', 'iron_ingot', 'gold_ingot', 'emerald', 'copper_ingot', 'netherite_scrap'];
