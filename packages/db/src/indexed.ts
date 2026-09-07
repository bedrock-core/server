/**
 * The index: which targets of a collection hold a document.
 *
 * A block entity cannot list its keys, an unloaded entity cannot be asked, and the plan forbids
 * scanning the world's property ids. So a collection keeps the identities of its documents in
 * world properties of its own: one string per chunk, entries joined by `\n`, a chunk capped under
 * the per-value limit (measured 32 767 characters, ~1 300 block identities). Loaded once into a
 * `Set`, then membership is a hash lookup and a change rewrites the one chunk it touched.
 *
 * An entry is added by the first write of a document and dropped by `delete`, by `onBreak`, and by
 * `all()` when it finds the target replaced. An orphan costs its identity's length until then.
 */
import type { DpHost } from './host';

const SEPARATOR = '\n';

export interface IndexSet {
  /** Loads the chunks on first use. */
  has(entry: string): boolean;
  add(entry: string): void;
  remove(entry: string): void;
  entries(): Iterable<string>;
  readonly size: number;
}

export function createIndexSet(host: DpHost, budget: number = host.caps.budget): IndexSet {
  let chunks: string[][] | undefined;
  let where: Map<string, number> | undefined;
  /** Joined length per chunk, so appending never re-joins 30 KB to measure it. */
  const lengths: number[] = [];

  const load = (): { chunks: string[][]; where: Map<string, number> } => {
    if (chunks !== undefined && where !== undefined) {
      return { chunks, where };
    }

    chunks = [];
    where = new Map();

    for (let i = 0; ; i++) {
      const raw = host.read(String(i));

      if (typeof raw !== 'string') {
        break;
      }

      const entries = raw.length === 0 ? [] : raw.split(SEPARATOR);

      chunks.push(entries);
      lengths.push(raw.length);

      for (const entry of entries) {
        where.set(entry, i);
      }
    }

    return { chunks, where };
  };

  const save = (index: number, entries: readonly string[]): void => {
    const raw = entries.join(SEPARATOR);

    lengths[index] = raw.length;
    host.write(String(index), raw);
  };

  return {
    has: (entry): boolean => load().where.has(entry),

    add: (entry): void => {
      const state = load();

      if (state.where.has(entry)) {
        return;
      }

      // Append to the last chunk while it fits, else open a new one.
      let index = state.chunks.length - 1;
      let target = index >= 0 ? state.chunks[index] : undefined;

      if (target === undefined || (lengths[index] ?? 0) + SEPARATOR.length + entry.length > budget) {
        target = [];
        index = state.chunks.push(target) - 1;
        lengths.push(0);
      }

      target.push(entry);
      state.where.set(entry, index);
      save(index, target);
    },

    remove: (entry): void => {
      const state = load();
      const index = state.where.get(entry);

      if (index === undefined) {
        return;
      }

      const target = state.chunks[index];

      if (target !== undefined) {
        const at = target.indexOf(entry);

        if (at >= 0) {
          target.splice(at, 1);
        }

        save(index, target);
      }

      state.where.delete(entry);
    },

    entries: (): Iterable<string> => load().where.keys(),

    get size(): number {
      return load().where.size;
    },
  };
}
