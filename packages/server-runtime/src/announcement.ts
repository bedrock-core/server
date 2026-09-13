/**
 * An announcement: one small, owner-written value under a framework key on the mirror.
 *
 * Every cross-addon feed built on it — the config schema, the i18n bundle, the feature flags,
 * the shared shape, and whatever a package above the runtime announces — is the same three moves:
 * the owner publishes a value under a `core-` key in its own namespace, every realm reads it
 * from its local mirror, and a listener hears when any namespace's value changes. This class is
 * those three moves once, typed by the value and guarded on read, so a peer publishing something
 * malformed reads as "nothing published" rather than poisoning a consumer.
 *
 * Late joiners are covered by sync's snapshot exchange; nothing here has to replay.
 */
import { stateKey } from '@bedrock-core/sync';
import type { State, StateKey, Unsubscribe } from '@bedrock-core/sync';

/**
 * Mirror keys under this prefix belong to the framework, not to the addon whose namespace they
 * ride in. Every announcement is minted here, and `core.shared` refuses a key that starts so.
 */
export const RESERVED_PREFIX = 'core-';

/** Told which namespace's announcement changed; read it back with `of(namespace)`. */
export type AnnouncementListener = (namespace: string) => void;

/** One owner-written value under a `core-` key: provide it, read any namespace's, hear it change. */
export class Announcement<T> {
  /** The mirror key, `core-<name>`, the same in every namespace. */
  readonly key: StateKey<T>;

  private readonly _state: State;
  private readonly _self: string;
  private readonly _is: (value: unknown) => value is T;

  constructor(state: State, self: string, name: string, is: (value: unknown) => value is T) {
    this.key = stateKey<T>(`${RESERVED_PREFIX}${name}`);
    this._state = state;
    this._self = self;
    this._is = is;
  }

  /** Publish this addon's value; replaces the previous one. */
  provide(value: T): void {
    this._state.set(this._self, this.key, value);
  }

  /** This addon's own published value, or `undefined` before it published one. */
  own(): T | undefined {
    return this.of(this._self);
  }

  /** What `namespace` published, or `undefined` when nothing has arrived or it fails the guard. */
  of(namespace: string): T | undefined {
    const value = this._state.get(namespace, this.key);

    return this._is(value) ? value : undefined;
  }

  /** Every namespace whose published value passes the guard, in mirror order. */
  namespaces(): string[] {
    return this._state.namespaces().filter(namespace => this.of(namespace) !== undefined);
  }

  /** Notified with the namespace whenever any addon's value changes, locally or from the wire. */
  subscribe(listener: AnnouncementListener): Unsubscribe {
    return this._state.subscribe((change) => {
      if (change.key === this.key) { listener(change.ns); }
    });
  }
}

/** A non-null, non-array object: the envelope every announcement guard starts from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
