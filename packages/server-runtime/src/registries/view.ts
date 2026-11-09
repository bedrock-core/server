import { observable, type Observable, type ReadonlyObservable, type Unsubscribe } from '@bedrock-core/observable';
import type { ReplicaSubscription, Replication } from '@bedrock-core/sync';
import { system } from '@minecraft/server';
import { isRecord } from '../guards';
import type { AddonRegistry, RegisteredAddon } from './addons';
import type { RegistryDescriptor } from './descriptor';
import { copyRegistryEntries, type RegistryDefinition, type RegistryEntries, type RegistryPublication } from './store';
import { Registry } from './base';

declare const referenceValue: unique symbol;

/** A serializable typed link. Creating a reference does not request its dataset. */
export interface RegistryReference<T> {
  readonly registry: string;
  readonly id: string;
  readonly revision?: number;
  readonly version?: number;
  readonly [referenceValue]?: (value: T) => T;
}

export interface RegistryEntry<T> {
  readonly id: string;
  readonly value: T;
  readonly provider: string;
  readonly instanceId: string;
  readonly descriptor: RegistryDescriptor;
  readonly version: number;
  readonly stale: boolean;
}

export type RegistryStatus = 'ready' | 'loading' | 'unavailable' | 'incompatible' | 'invalid' | 'stopped';

export interface RegistryProvider<T> {
  readonly id: string;
  readonly instanceId: string;
  readonly descriptor: RegistryDescriptor;
  readonly status: RegistryStatus | 'missing' | 'stale';
  readonly version: number;
  readonly entries: RegistryEntries<T>;
}

export interface RegistrySnapshot<T> {
  readonly status: RegistryStatus;
  readonly providers: readonly RegistryProvider<T>[];
  readonly entries: Readonly<Record<string, RegistryEntry<T>>>;
}

export interface RegistryReadOptions<T> {
  readonly providers?: readonly string[];
  /** The consumer's target Minecraft version. Bounded coverage is checked when supplied. */
  readonly minecraft?: readonly [number, number, number];
  /** Defaults to the definition's exact contract version. Every received record is still validated. */
  readonly contracts?: readonly number[];
  readonly retainOnDeparture?: boolean;
  /** Candidates are ordered by availability, descending dataset revision and provider identity. */
  readonly select?: (candidates: readonly RegistryEntry<T>[]) => RegistryEntry<T> | undefined;
}

export type RegistryResolution<T>
  = | { readonly status: 'ready' | 'stale'; readonly entry: RegistryEntry<T> }
    | { readonly status: Exclude<RegistryStatus, 'ready'> | 'missing' };

export interface RegistryReader<T> extends Registry<T, RegistrySnapshot<T>> {
  readonly snapshot: ReadonlyObservable<RegistrySnapshot<T>>;
  get(id: string): T | undefined;
  all(): readonly RegistryEntry<T>[];
  of(provider: string): RegistryEntries<T> | undefined;
  /** Passing a source record pins a related lookup to that provider, running instance and dataset revision. */
  resolve(reference: RegistryReference<T>, from?: RegistryEntry<unknown>): RegistryResolution<T>;
  whenReady(timeoutTicks?: number): Promise<void>;
  stop(): void;
}

/** Build a link without acquiring or subscribing to another registry. */
export function registryReference<T>(definition: RegistryDefinition<T>, id: string, pins: { revision?: number; version?: number } = {}): RegistryReference<T> {
  if (typeof id !== 'string' || id.length === 0 || [pins.revision, pins.version].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new TypeError('invalid registry reference');
  }

  return Object.freeze({ registry: definition.id, id, ...pins });
}

/** Validate a transported link against its owning library's registry contract. */
export function isRegistryReference<T>(definition: RegistryDefinition<T>, value: unknown): value is RegistryReference<T> {
  return isRecord(value) && value.registry === definition.id && typeof value.id === 'string' && value.id.length > 0
    && [value.revision, value.version].every(pin => pin === undefined || (typeof pin === 'number' && Number.isSafeInteger(pin) && pin >= 0));
}

interface Slot<T> {
  addon: RegisteredAddon;
  descriptor: RegistryDescriptor;
  state: RegistryProvider<T>;
  release: Unsubscribe;
  watch?: ReplicaSubscription;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) { return left[index] - right[index]; }
  }

  return 0;
}

/** @internal A library's owned consumer interest, with one atomic view over compatible providers. */
export class RegistryView<T> extends Registry<T, RegistrySnapshot<T>> implements RegistryReader<T> {
  readonly snapshot: ReadonlyObservable<RegistrySnapshot<T>>;
  private readonly _source: Observable<RegistrySnapshot<T>>;
  private readonly _slots = new Map<string, Slot<T>>();
  private readonly _waiting = new Set<() => void>();
  private readonly _release: Unsubscribe;
  private _stopped = false;

  constructor(
    private readonly _definition: RegistryDefinition<T>,
    private readonly _options: RegistryReadOptions<T>,
    private readonly _directory: AddonRegistry,
    private readonly _replication: Replication,
    private readonly _local: (id: string) => RegistryPublication<unknown> | undefined,
    private readonly _withdraw: (view: RegistryReader<T>) => void,
  ) {
    super();
    this._source = observable<RegistrySnapshot<T>>(Object.freeze({ status: 'unavailable', providers: [], entries: {} }));
    this.snapshot = this._source;
    this._release = this._directory.addons.subscribe(() => this._refresh());

    try { this._refresh(); } catch (error) { this.stop(); throw error; }
  }

  get(id: string): T | undefined {
    const entries = this._source.get().entries;

    return Object.hasOwn(entries, id) ? entries[id]?.value : undefined;
  }

  all(): readonly RegistryEntry<T>[] {
    return this._source.get().providers.flatMap(provider => Object.entries(provider.entries).map(([id, value]) => this._entry(provider, id, value)));
  }

  of(provider: string): RegistryEntries<T> | undefined {
    const found = this._source.get().providers.find(candidate => candidate.id === provider);

    return found?.status === 'ready' || found?.status === 'stale' ? found.entries : undefined;
  }

  resolve(reference: RegistryReference<T>, from?: RegistryEntry<unknown>): RegistryResolution<T> {
    if (this._stopped) { return { status: 'stopped' }; }

    if (reference.registry !== this._definition.id) { return { status: 'incompatible' }; }

    const state = this._source.get();
    let entry = Object.hasOwn(state.entries, reference.id) ? state.entries[reference.id] : undefined;

    if (from !== undefined) {
      const provider = state.providers.find(candidate => candidate.id === from.provider && candidate.instanceId === from.instanceId);

      if (provider === undefined) { return { status: 'unavailable' }; }

      if (provider.descriptor.revision !== from.descriptor.revision) { return { status: 'loading' }; }

      entry = Object.hasOwn(provider.entries, reference.id) ? this._entry(provider, reference.id, provider.entries[reference.id]) : undefined;
    }

    if (entry !== undefined) {
      if ((reference.revision !== undefined && entry.descriptor.revision !== reference.revision)
        || (reference.version !== undefined && entry.version !== reference.version)) { return { status: 'loading' }; }

      return { status: entry.stale ? 'stale' : 'ready', entry };
    }

    return { status: state.status === 'ready' ? 'missing' : state.status };
  }

  whenReady(timeoutTicks = 100): Promise<void> {
    if (this._source.get().status === 'ready') { return Promise.resolve(); }

    if (this._stopped) { return Promise.reject(new Error('registry is stopped')); }

    return new Promise((resolve, reject) => {
      const finish = (): void => {
        const status = this._source.get().status;

        if (status !== 'ready' && status !== 'stopped') { return; }

        cleanup();

        if (status === 'ready') { resolve(); } else { reject(new Error('registry is stopped')); }
      };

      const cleanup = (): void => {
        system.clearRun(timeout);
        release();
        this._waiting.delete(finish);
      };

      const release = this.snapshot.subscribe(finish);
      const timeout = system.runTimeout(() => {
        cleanup();
        reject(new Error(`registry '${this._definition.id}' is unavailable after ${timeoutTicks} ticks`));
      }, timeoutTicks);

      this._waiting.add(finish);
      finish();
    });
  }

  stop(): void {
    if (this._stopped) { return; }

    this._stopped = true;
    this._release();

    for (const slot of this._slots.values()) { slot.release(); slot.watch?.stop(); }

    this._slots.clear();
    this._source.set(Object.freeze({ status: 'stopped', providers: [], entries: {} }));

    for (const finish of [...this._waiting]) { finish(); }

    this._withdraw(this);
  }

  private _compatible(descriptor: RegistryDescriptor): boolean {
    if (!(this._options.contracts ?? [this._definition.contract]).includes(descriptor.contract)) { return false; }

    const version = this._options.minecraft;
    const coverage = descriptor.minecraft;

    return version === undefined || coverage === undefined
      || (compareVersion(version, coverage.min) >= 0 && (coverage.max === undefined || compareVersion(version, coverage.max) <= 0));
  }

  private _refresh(): void {
    if (this._stopped) { return; }

    const candidates = this._directory.all().flatMap((addon) => {
      if (this._options.providers !== undefined && !this._options.providers.includes(addon.id)) { return []; }

      return addon.registries.filter(descriptor => descriptor.id === this._definition.id).map(descriptor => ({ addon, descriptor }));
    });
    const compatible = candidates.filter(candidate => this._compatible(candidate.descriptor));

    for (const [id, slot] of this._slots) {
      const current = compatible.find(candidate => candidate.addon.id === id && candidate.addon.instanceId === slot.addon.instanceId
        && JSON.stringify(candidate.descriptor) === JSON.stringify(slot.descriptor));

      if (current !== undefined && slot.state.status !== 'stale') { continue; }

      slot.release();
      slot.watch?.stop();

      if (this._options.retainOnDeparture && !compatible.some(candidate => candidate.addon.id === id)
        && (slot.state.status === 'ready' || slot.state.status === 'stale')) {
        slot.state = Object.freeze({ ...slot.state, status: 'stale' });

        slot.release = (): void => {};

        slot.watch = undefined;
      } else { this._slots.delete(id); }
    }

    for (const { addon, descriptor } of compatible) {
      if (this._slots.has(addon.id)) { continue; }

      const slot: Slot<T> = { addon, descriptor, release: (): void => {}, state: Object.freeze({ id: addon.id,
        instanceId: addon.instanceId, descriptor, status: 'loading', version: -1, entries: {} }) };

      this._slots.set(addon.id, slot);

      if (addon.self) {
        const local = this._local(descriptor.id);

        if (local !== undefined) {
          slot.release = local.snapshot.subscribe(value => this._accept(slot, { descriptor, snapshot: value }));
          this._accept(slot, { descriptor, snapshot: local.snapshot.get() });
        }
      } else {
        const watch = this._replication.watch(addon.id, addon.instanceId, `registry/${descriptor.id}`);

        const refresh = (): void => {
          const value = watch.snapshot.get();

          if (value.status === 'ready') { this._accept(slot, value.value); } else {
            slot.state = this._options.retainOnDeparture && value.status === 'unavailable' && slot.state.status === 'ready'
              ? Object.freeze({ ...slot.state, status: 'stale' })
              : Object.freeze({ ...slot.state, status: value.status, entries: {} });
            this._publish();
          }
        };

        slot.watch = watch;
        slot.release = watch.snapshot.subscribe(refresh);
        refresh();
      }
    }

    this._publish(candidates.length > 0 && compatible.length === 0 ? 'incompatible' : 'unavailable');
  }

  private _accept(slot: Slot<T>, value: unknown): void {
    try {
      if (!isRecord(value) || JSON.stringify(value.descriptor) !== JSON.stringify(slot.descriptor)
        || !isRecord(value.snapshot) || typeof value.snapshot.version !== 'number'
        || !Number.isSafeInteger(value.snapshot.version) || value.snapshot.version < 0) { throw new TypeError('invalid registry snapshot'); }

      const entries = copyRegistryEntries(this._definition, value.snapshot.entries);

      slot.state = Object.freeze({ id: slot.addon.id, instanceId: slot.addon.instanceId, descriptor: slot.descriptor,
        status: 'ready', version: value.snapshot.version, entries });
    } catch {
      slot.state = Object.freeze({ ...slot.state, status: 'invalid', entries: {} });
    }

    this._publish();
  }

  private _entry(provider: RegistryProvider<T>, id: string, value: T): RegistryEntry<T> {
    return Object.freeze({ id, value, provider: provider.id, instanceId: provider.instanceId,
      descriptor: provider.descriptor, version: provider.version, stale: provider.status === 'stale' });
  }

  private _publish(empty: RegistryStatus = 'unavailable'): void {
    if (this._stopped) { return; }

    const providers = Object.freeze([...this._slots.values()].map(slot => slot.state));
    const records = new Map<string, RegistryEntry<T>[]>();

    for (const provider of providers) {
      for (const [id, value] of Object.entries(provider.entries)) {
        const candidates = records.get(id) ?? [];

        candidates.push(this._entry(provider, id, value));
        records.set(id, candidates);
      }
    }

    const entries = Object.freeze(Object.fromEntries([...records].flatMap(([id, candidates]) => {
      candidates.sort((left, right) => Number(left.stale) - Number(right.stale)
        || right.descriptor.revision - left.descriptor.revision || (left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0));
      const selected = this._options.select === undefined ? candidates[0] : this._options.select(Object.freeze(candidates));

      return selected === undefined
        ? []
        : [[id, candidates.includes(selected)
            ? selected
            : Object.freeze({ ...selected, value: copyRegistryEntries(this._definition, { [id]: selected.value })[id] })]];
    })));
    const status: RegistryStatus = providers.some(provider => provider.status === 'loading')
      ? 'loading'
      : providers.some(provider => provider.status === 'ready' || provider.status === 'stale')
        ? 'ready'
        : providers.some(provider => provider.status === 'invalid') ? 'invalid' : empty;

    this._source.set(Object.freeze({ status, providers, entries }));
  }
}
