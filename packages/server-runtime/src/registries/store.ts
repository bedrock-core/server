import { observable, type ReadonlyObservable } from '@bedrock-core/observable';
import { cloneData, freezeData } from '@bedrock-core/sync/data';
import type { RegistryDescriptor, RegistryMinecraftCoverage } from './descriptor';
import { isRecord } from '../guards';
import { Registry } from './base';

/** The owning library identifies and validates records without importing their implementation into Core. */
export interface RegistryDefinition<T> {
  readonly id: string;
  readonly contract: number;
  readonly accepts: (value: unknown) => value is T;
}

export type RegistryEntries<T> = Readonly<Record<string, T>>;

/** One atomic local view. Its version advances on changes within a publication's lifetime. */
export interface RegistrySnapshot<T> {
  readonly version: number;
  readonly entries: RegistryEntries<T>;
}

export interface RegistryPublicationOptions<T> {
  readonly revision: number;
  readonly minecraft?: RegistryMinecraftCoverage;
  readonly entries?: RegistryEntries<T>;
}

/** A library's owned publication. Snapshots are copied, validated and deeply frozen. */
export interface RegistryPublication<T> extends Registry<T, RegistrySnapshot<T>> {
  readonly descriptor: RegistryDescriptor;
  readonly snapshot: ReadonlyObservable<RegistrySnapshot<T>>;
  get(id: string): T | undefined;
  set(id: string, value: T): void;
  delete(id: string): boolean;
  replace(entries: RegistryEntries<T>): void;
  /** Withdraw this publication. Repeating withdrawal is safe; later writes reject. */
  stop(): void;
}

function entryId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) { throw new TypeError('registry entry id must be nonempty'); }
}

/** @internal Validate a complete snapshot before exposing any of its records. */
export function copyRegistryEntries<T>(definition: RegistryDefinition<T>, entries: unknown): RegistryEntries<T> {
  if (!isRecord(entries)) { throw new TypeError('registry entries must be an object'); }

  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([id, value]) => {
    entryId(id);
    const copy = cloneData(value);

    if (!definition.accepts(copy)) { throw new TypeError(`invalid record for registry '${definition.id}'`); }

    return [id, freezeData(copy)];
  })));
}

/** @internal Memory storage owned by a Runtime registry host. */
export class RegistryStore<T> extends Registry<T, RegistrySnapshot<T>> implements RegistryPublication<T> {
  readonly snapshot: ReadonlyObservable<RegistrySnapshot<T>>;
  private readonly _source;
  private _stopped = false;

  constructor(
    readonly descriptor: RegistryDescriptor,
    private readonly _definition: RegistryDefinition<T>,
    entries: RegistryEntries<T>,
    private readonly _withdraw: () => void,
  ) {
    super();
    this._source = observable<RegistrySnapshot<T>>(Object.freeze({ version: 0, entries: this._copy(entries) }));
    this.snapshot = this._source;
  }

  get(id: string): T | undefined {
    const entries = this._source.get().entries;

    return Object.hasOwn(entries, id) ? entries[id] : undefined;
  }

  set(id: string, value: T): void {
    this._requireActive();
    entryId(id);
    const copy = this._value(value);
    const previous = this._source.get();

    this._source.set(Object.freeze({ version: previous.version + 1,
      entries: Object.freeze({ ...previous.entries, [id]: copy }) }));
  }

  delete(id: string): boolean {
    this._requireActive();
    const previous = this._source.get();

    if (!Object.hasOwn(previous.entries, id)) { return false; }

    const entries = Object.fromEntries(Object.entries(previous.entries).filter(([key]) => key !== id));

    this._source.set(Object.freeze({ version: previous.version + 1, entries: Object.freeze(entries) }));

    return true;
  }

  replace(entries: RegistryEntries<T>): void {
    this._requireActive();
    const copy = this._copy(entries);

    this._source.set(Object.freeze({ version: this._source.get().version + 1, entries: copy }));
  }

  stop(): void {
    if (this._stopped) { return; }

    this._stopped = true;

    try { this._withdraw(); } finally {
      this._source.set(Object.freeze({ version: this._source.get().version + 1, entries: Object.freeze({}) }));
    }
  }

  private _copy(entries: RegistryEntries<T>): RegistryEntries<T> {
    return copyRegistryEntries(this._definition, entries);
  }

  private _value(value: T): T {
    const copy = cloneData(value);

    if (!this._definition.accepts(copy)) { throw new TypeError(`invalid record for registry '${this.descriptor.id}'`); }

    return freezeData(copy);
  }

  private _requireActive(): void {
    if (this._stopped) { throw new Error(`registry '${this.descriptor.id}' is stopped`); }
  }
}
