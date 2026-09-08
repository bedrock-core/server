/**
 * How a document becomes bytes on a host and comes back — one codec for every host.
 *
 * On disk a document is one JSON string, `{"v":<version>,"d":<doc>}`, under the collection's
 * key. The envelope carries the version so a document written by version 1 of an addon is
 * migrated to version 4 the first time version 4 reads it — lazily, per document, because block
 * and entity documents are never all loaded at once. What is stored is exactly what was written:
 * a collection fills `defaults` on top of what this reads, so they are never persisted.
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
import type { DeepPartial } from './merge';

/** One migration step: the document as the previous version wrote it, to the next shape. */
export type MigrateStep = (doc: Record<string, unknown>) => Record<string, unknown>;

export interface DocumentSchema<T extends object> {
  /** The version documents are written at. `1` when omitted; documents at that version never migrate. */
  version?: number;
  /**
   * Filled into missing keys on read, at every depth — a nested object with one key stored still
   * reads with its siblings' defaults. Never persisted, so changing a default reaches every
   * document that never wrote that key.
   */
  defaults?: DeepPartial<T>;
  /** Keyed by the version the step produces: `migrate[3]` takes a version-2 document to version 3. */
  migrate?: Record<number, MigrateStep>;
  /**
   * Runs on every write — `set`, `patch`, and a peer's RPC alike — over the document about to be
   * stored, before defaults; what it returns is what is written. The place to coerce a value
   * into range, or to drop a key that equals its default so the default keeps applying.
   */
  normalize?: (doc: T) => T;
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

export interface DocumentStoreOptions<T extends object> extends Pick<DocumentSchema<T>, 'version' | 'migrate'> {
  /** For the error and log lines. */
  collection: string;
  /** Where the log line for a quarantine goes. `console.warn` when omitted. */
  log?: (message: string) => void;
}

/** Reads and writes documents of one collection on one resolved host. */
export interface DocumentStore<T extends object> {
  /**
   * The document as stored, migrated to the current version. `undefined` when there is none, or
   * when it was unreadable and has been quarantined. Defaults are not applied here.
   */
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

class DocumentStoreImpl<T extends object> implements DocumentStore<T> {
  private readonly _version: number;
  private readonly _chunked: boolean;

  constructor(private readonly _host: DpHost, private readonly _options: DocumentStoreOptions<T>) {
    this._version = _options.version ?? 1;
    this._chunked = _host.abi !== 'component';
  }

  read(key: string): T | undefined {
    const raw = this._readRaw(key);

    if (raw === undefined) {
      return undefined;
    }

    let envelope: Envelope | undefined;

    try {
      envelope = parseEnvelope(raw);
    } catch (error) {
      return this._quarantine(key, raw, `not JSON: ${String(error)}`);
    }

    if (envelope === undefined) {
      return this._quarantine(key, raw, 'not a document envelope');
    }

    if (envelope.v > this._version) {
      return this._quarantine(key, raw, `written at version ${envelope.v}, this addon reads version ${this._version}`);
    }

    if (envelope.v === this._version) {
      return this._typed(envelope.d);
    }

    let migrated: Record<string, unknown>;

    try {
      migrated = this._migrate(envelope);
    } catch (error) {
      return this._quarantine(key, raw, `migration from version ${envelope.v} failed: ${String(error)}`);
    }

    // Migrated once, written once: the next read is a plain parse.
    this._writeRaw(key, JSON.stringify({ v: this._version, d: migrated }));

    return this._typed(migrated);
  }

  write(key: string, doc: T): void {
    this._writeRaw(key, JSON.stringify({ v: this._version, d: doc }));
  }

  remove(key: string): void {
    const count = this._chunkCount(key);

    if (count === 0) {
      this._host.write(key, undefined);

      return;
    }

    const values: Record<string, undefined> = { [key]: undefined };

    for (let i = 0; i < count; i++) {
      values[`${key}${CHUNKS}${i}`] = undefined;
    }

    this._host.writeMany(values);
  }

  keys(): readonly string[] | undefined {
    return this._host.keys()?.filter(key => !isDerivedKey(key));
  }

  private _log(message: string): void {
    if (this._options.log !== undefined) {
      this._options.log(message);
    } else {
      console.warn(message);
    }
  }

  private _chunkCount(key: string): number {
    const head = this._host.read(key);

    return typeof head === 'string' && head.startsWith(CHUNKS) ? Number(head.slice(CHUNKS.length)) : 0;
  }

  private _readRaw(key: string): string | undefined {
    const head = this._host.read(key);

    if (typeof head !== 'string') {
      return undefined;
    }

    if (!head.startsWith(CHUNKS)) {
      return head;
    }

    const count = Number(head.slice(CHUNKS.length));
    let joined = '';

    for (let i = 0; i < count; i++) {
      const part = this._host.read(`${key}${CHUNKS}${i}`);

      if (typeof part !== 'string') {
        return undefined;
      }

      joined += part;
    }

    return joined;
  }

  private _writeRaw(key: string, raw: string): void {
    const budget = this._host.caps.budget;

    if (!this._chunked) {
      // The component budget counts key and value together, per block per pack.
      if (key.length + raw.length > budget) {
        throw new DbBudgetError(this._options.collection, key, key.length + raw.length, budget);
      }

      this._host.write(key, raw);

      return;
    }

    const previous = this._chunkCount(key);

    if (raw.length <= budget && previous === 0) {
      this._host.write(key, raw);

      return;
    }

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

    this._host.writeMany(values);
  }

  private _quarantine(key: string, raw: string, why: string): undefined {
    this._log(`[db] ${this._options.collection}: document '${key}' quarantined under '${key}${BAD}' — ${why}`);

    try {
      this._writeRaw(`${key}${BAD}`, raw);
    } catch (error) {
      this._log(`[db] ${this._options.collection}: could not keep the quarantined copy of '${key}': ${String(error)}`);
    }

    this.remove(key);

    return undefined;
  }

  private _migrate(envelope: Envelope): Record<string, unknown> {
    let doc = envelope.d;

    for (let v = envelope.v + 1; v <= this._version; v++) {
      const step = this._options.migrate?.[v];

      if (step === undefined) {
        throw new Error(`no migration step to version ${v}`);
      }

      doc = step(doc);
    }

    return doc;
  }

  // The caller's type is the contract for what is on disk; the store cannot check it.
  private _typed(doc: Record<string, unknown>): T {
    return doc as T; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }
}

export function createDocumentStore<T extends object>(host: DpHost, options: DocumentStoreOptions<T>): DocumentStore<T> {
  return new DocumentStoreImpl(host, options);
}
