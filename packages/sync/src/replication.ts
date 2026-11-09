import { observable, type Observable, type ReadonlyObservable, type Unsubscribe } from '@bedrock-core/observable';
import type { Bus } from './bus';
import type { Discovery } from './discovery';
import type { Envelope } from './envelope';
import { MessageType } from './constants';
import { cloneData, freezeData } from './data';

/** Latest immutable value from one publisher instance, or its availability state. */
export interface ReplicaSnapshot {
  readonly status: 'loading' | 'ready' | 'missing' | 'unavailable' | 'stopped';
  readonly generation: number;
  readonly revision: number;
  readonly value?: unknown;
}

/** An owned interest in a remote publication. Stop it to release retained data. */
export interface ReplicaSubscription {
  readonly snapshot: ReadonlyObservable<ReplicaSnapshot>;
  stop(): void;
}

/** A local publication. Each set broadcasts its complete replacement value. */
export interface ReplicaPublication {
  set(value: unknown): void;
  stop(): void;
}

interface Publication {
  readonly generation: number;
  revision: number;
  value: unknown;
}

interface Watch {
  readonly id: string;
  readonly instance: string;
  readonly key: string;
  readonly token: string;
  readonly source: Observable<ReplicaSnapshot>;
  users: number;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Named snapshot broadcasts. Only explicit watches retain foreign values; schemas belong to callers. */
export class Replication {
  private readonly _publications = new Map<string, Publication>();
  private readonly _generations = new Map<string, number>();
  private readonly _watches = new Map<string, Watch>();
  private _release: Unsubscribe | undefined;
  private _clock = 0;

  constructor(private readonly _bus: Bus, private readonly _discovery: Discovery) {}

  start(): void {
    this._release ??= this._bus.on(MessageType.Replica, envelope => this._receive(envelope));
  }

  /** Publish a node-local key with a copied, immutable value. Duplicate keys throw. */
  publish(key: string, value: unknown): ReplicaPublication {
    if (this._publications.has(key)) { throw new Error('replica \'' + key + '\' is already published'); }

    const publication: Publication = { generation: ++this._clock, revision: 0, value: freezeData(cloneData(value)) };

    this._publications.set(key, publication);
    this._generations.set(key, publication.generation);
    this._sendSnapshot(key);

    return {
      set: (next): void => {
        if (this._publications.get(key) !== publication) { throw new Error('replica \'' + key + '\' is stopped'); }

        publication.value = freezeData(cloneData(next));
        publication.revision++;
        this._sendSnapshot(key);
      },
      stop: (): void => {
        if (this._publications.get(key) !== publication) { return; }

        this._publications.delete(key);
        this._generations.set(key, ++this._clock);
        this._sendSnapshot(key);
      },
    };
  }

  /** Watch one remote instance and key. Shared watches request once; each returned handle must be stopped. */
  watch(id: string, instance: string, key: string): ReplicaSubscription {
    if (this._release === undefined) { throw new Error('replication is not started'); }

    const identity = JSON.stringify([id, instance, key]);
    let watch = this._watches.get(identity);

    if (watch === undefined) {
      watch = { id, instance, key, token: String(++this._clock), users: 0,
        source: observable<ReplicaSnapshot>(Object.freeze({ status: 'loading', generation: -1, revision: -1 })) };
      this._watches.set(identity, watch);
      this._bus.send({ dst: id, type: MessageType.Replica, data: { op: 'request', key, token: watch.token, target: instance } });
    }

    watch.users++;
    const owned = watch;
    let stopped = false;

    return {
      snapshot: owned.source,
      stop: (): void => {
        if (stopped) { return; }

        stopped = true;

        if (this._watches.get(identity) !== owned || --owned.users > 0) { return; }

        this._watches.delete(identity);
        owned.source.set(Object.freeze({ status: 'stopped', generation: -1, revision: -1 }));
      },
    };
  }

  /** Invalidate values from a departed instance. SyncNode calls this when discovery changes. */
  forgetPeer(id: string, instance: string): void {
    for (const watch of this._watches.values()) {
      if (watch.id === id && watch.instance === instance) {
        const previous = watch.source.get();

        watch.source.set(Object.freeze({ status: 'unavailable', generation: previous.generation, revision: previous.revision }));
      }
    }
  }

  stop(): void {
    this._release?.();
    this._release = undefined;

    for (const watch of this._watches.values()) {
      watch.source.set(Object.freeze({ status: 'stopped', generation: -1, revision: -1 }));
    }

    this._watches.clear();
    this._publications.clear();
    this._generations.clear();
  }

  private _sendSnapshot(key: string, reader?: { id: string; instance: string; token: string }): void {
    const publication = this._publications.get(key);

    this._bus.send({ ...(reader === undefined ? {} : { dst: reader.id }), type: MessageType.Replica, data: {
      op: 'snapshot', key, generation: publication?.generation ?? this._generations.get(key) ?? 0,
      revision: publication?.revision ?? 0, present: publication !== undefined,
      ...(reader === undefined ? {} : { target: reader.instance, token: reader.token }),
      ...(publication === undefined ? {} : { value: publication.value }),
    } });
  }

  private _receive(envelope: Envelope): void {
    const data = envelope.data;

    if (!isRecord(data) || typeof data.key !== 'string') { return; }

    if (data.op === 'request') {
      if (envelope.dst === this._bus.selfId && data.target === this._bus.instanceId && typeof data.token === 'string') {
        this._sendSnapshot(data.key, { id: envelope.src, instance: envelope.iid, token: data.token });
      }

      return;
    }

    if (data.op !== 'snapshot' || !integer(data.generation) || !integer(data.revision) || typeof data.present !== 'boolean'
      || this._discovery.getPeer(envelope.src)?.instanceId !== envelope.iid) { return; }

    const watch = this._watches.get(JSON.stringify([envelope.src, envelope.iid, data.key]));

    if (watch === undefined || (envelope.dst !== undefined
      && (envelope.dst !== this._bus.selfId || data.target !== this._bus.instanceId || data.token !== watch.token))) { return; }

    const previous = watch.source.get();

    if (data.generation < previous.generation || (data.generation === previous.generation
      && (data.revision < previous.revision || (data.revision === previous.revision && previous.status !== 'unavailable')))) { return; }

    watch.source.set(Object.freeze({ status: data.present ? 'ready' : 'missing', generation: data.generation,
      revision: data.revision, ...(data.present ? { value: freezeData(cloneData(data.value)) } : {}) }));
  }
}
