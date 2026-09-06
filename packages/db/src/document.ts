/**
 * How a document becomes bytes on a host and comes back — one codec for every host.
 *
 * On disk a document is one JSON string, `{"v":<version>,"d":<doc>}`, under the collection's
 * key. The envelope carries the version so a document written by version 1 of an addon is
 * migrated to version 4 the first time version 4 reads it — lazily, per document, because block
 * and entity documents are never all loaded at once. `defaults` are applied on read and never
 * stored, so changing a default reaches every document without a migration.
 *
 * A string past the host's per-value cap throws in the engine (measured: 32 767 characters on the
 * direct ABI), so a document that does not fit in one value is split into `key#0..n` with the
 * chunk count under `key`. That is a safety net on the direct and proxied hosts only: a block
 * entity's ~950 bytes are the whole budget, and a document that does not fit there is refused.
 *
 * A document that cannot be parsed or migrated is quarantined under `key#bad`, not deleted:
 * persistence that discards a player's data on a bad deploy is worse than an error, and the copy
 * is what makes a fix possible.
 */
import { DbBudgetError } from './errors';
import type { DpHost } from './host';

/** One migration step: the document as the previous version wrote it, to the next shape. */
export type MigrateStep = (doc: Record<string, unknown>) => Record<string, unknown>;

export interface DocumentSchema<T extends object> {
  /** The version documents are written at. `1` when omitted; documents at that version never migrate. */
  version?: number;
  /** Filled into missing keys on read. Never persisted. */
  defaults?: Partial<T>;
  /** Keyed by the version the step produces: `migrate[3]` takes a version-2 document to version 3. */
  migrate?: Record<number, MigrateStep>;
}

declare const documentType: unique symbol;

/**
 * A `DocumentSchema` that also names its document type, so a collection whose `accept` fixes the
 * target type can take the document type from the schema instead of an explicit type argument —
 * TypeScript infers all of a call's type arguments or none.
 */
export type Schema<T extends object> = DocumentSchema<T> & { readonly [documentType]?: (doc: T) => T };

/** Declare a document type, with or without a version and migrations: `schema<Elevator>({ version: 2 })`. */
export function schema<T extends object>(definition: DocumentSchema<T> = {}): Schema<T> {
  return definition;
}

export interface DocumentStoreOptions<T extends object> extends DocumentSchema<T> {
  /** For the error and log lines. */
  collection: string;
  /** Where the log line for a quarantine goes. `console.warn` when omitted. */
  log?: (message: string) => void;
}

/** Reads and writes documents of one collection on one resolved host. */
export interface DocumentStore<T extends object> {
  /** `undefined` when there is no document, or when it was unreadable and has been quarantined. */
  read(key: string): T | undefined;
  /** Throws `DbBudgetError` when the document does not fit; nothing is written then. */
  write(key: string, doc: T): void;
  remove(key: string): void;
  /** Document keys under this collection, or `undefined` on a host that cannot list. */
  keys(): readonly string[] | undefined;
}

const CHUNKS = '#';
const BAD = '#bad';

interface Envelope {
  v: number;
  d: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): Envelope | undefined {
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed) || typeof parsed.v !== 'number' || !isRecord(parsed.d)) {
    return undefined;
  }

  return { v: parsed.v, d: parsed.d };
}

/** Is this key a chunk or quarantine of another document rather than a document of its own. */
function isDerivedKey(key: string): boolean {
  const hash = key.lastIndexOf(CHUNKS);

  if (hash < 0) {
    return false;
  }

  const suffix = key.slice(hash + 1);

  return suffix === 'bad' || /^\d+$/.test(suffix);
}

export function createDocumentStore<T extends object>(host: DpHost, options: DocumentStoreOptions<T>): DocumentStore<T> {
  const version = options.version ?? 1;
  const log = options.log ?? ((message: string): void => {
    console.warn(message);
  });
  const chunked = host.abi !== 'component';

  const chunkCount = (key: string): number => {
    const head = host.read(key);

    return typeof head === 'string' && head.startsWith(CHUNKS) ? Number(head.slice(CHUNKS.length)) : 0;
  };

  const readRaw = (key: string): string | undefined => {
    const head = host.read(key);

    if (typeof head !== 'string') {
      return undefined;
    }

    if (!head.startsWith(CHUNKS)) {
      return head;
    }

    const count = Number(head.slice(CHUNKS.length));
    let joined = '';

    for (let i = 0; i < count; i++) {
      const part = host.read(`${key}${CHUNKS}${i}`);

      if (typeof part !== 'string') {
        return undefined;
      }

      joined += part;
    }

    return joined;
  };

  const removeRaw = (key: string): void => {
    const count = chunkCount(key);
    const values: Record<string, undefined> = { [key]: undefined };

    for (let i = 0; i < count; i++) {
      values[`${key}${CHUNKS}${i}`] = undefined;
    }

    host.writeMany(values);
  };

  const writeRaw = (key: string, raw: string): void => {
    const budget = host.caps.budget;

    if (!chunked) {
      // The component budget counts key and value together, per block per pack.
      if (key.length + raw.length > budget) {
        throw new DbBudgetError(options.collection, key, key.length + raw.length, budget);
      }

      host.write(key, raw);

      return;
    }

    const previous = chunkCount(key);
    const values: Record<string, string | undefined> = {};
    let count = 0;

    if (raw.length <= budget) {
      values[key] = raw;
    } else {
      count = Math.ceil(raw.length / budget);
      values[key] = `${CHUNKS}${count}`;

      for (let i = 0; i < count; i++) {
        values[`${key}${CHUNKS}${i}`] = raw.slice(i * budget, (i + 1) * budget);
      }
    }

    for (let i = count; i < previous; i++) {
      values[`${key}${CHUNKS}${i}`] = undefined;
    }

    host.writeMany(values);
  };

  const quarantine = (key: string, raw: string, why: string): undefined => {
    log(`[db] ${options.collection}: document '${key}' quarantined under '${key}${BAD}' — ${why}`);

    try {
      writeRaw(`${key}${BAD}`, raw);
    } catch (error) {
      log(`[db] ${options.collection}: could not keep the quarantined copy of '${key}': ${String(error)}`);
    }

    removeRaw(key);

    return undefined;
  };

  const migrate = (envelope: Envelope): Record<string, unknown> => {
    let doc = envelope.d;

    for (let v = envelope.v + 1; v <= version; v++) {
      const step = options.migrate?.[v];

      if (step === undefined) {
        throw new Error(`no migration step to version ${v}`);
      }

      doc = step(doc);
    }

    return doc;
  };

  // The caller's type is the contract for what is on disk; the store cannot check it.
  const withDefaults = (doc: Record<string, unknown>): T => {
    const defaults = options.defaults;
    const filled: unknown = defaults === undefined ? doc : { ...defaults, ...doc };

    return filled as T; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  };

  return {
    read: (key): T | undefined => {
      const raw = readRaw(key);

      if (raw === undefined) {
        return undefined;
      }

      let envelope: Envelope | undefined;

      try {
        envelope = parseEnvelope(raw);
      } catch (error) {
        return quarantine(key, raw, `not JSON: ${String(error)}`);
      }

      if (envelope === undefined) {
        return quarantine(key, raw, 'not a document envelope');
      }

      if (envelope.v > version) {
        return quarantine(key, raw, `written at version ${envelope.v}, this addon reads version ${version}`);
      }

      if (envelope.v === version) {
        return withDefaults(envelope.d);
      }

      let migrated: Record<string, unknown>;

      try {
        migrated = migrate(envelope);
      } catch (error) {
        return quarantine(key, raw, `migration from version ${envelope.v} failed: ${String(error)}`);
      }

      // Migrated once, written once: the next read is a plain parse.
      writeRaw(key, JSON.stringify({ v: version, d: migrated }));

      return withDefaults(migrated);
    },

    write: (key, doc): void => {
      writeRaw(key, JSON.stringify({ v: version, d: doc }));
    },

    remove: removeRaw,

    keys: (): readonly string[] | undefined => host.keys()?.filter(key => !isDerivedKey(key)),
  };
}
