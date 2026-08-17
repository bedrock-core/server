import type { Unsubscribe } from '@bedrock-core/sync';
import type {
  ConfigValue,
  FlatSchema,
  SchemaToValue,
  DotPath,
  PathValue,
  DeepPartial,
} from '../schema';
import { ChangeEmitter, type ChangeListener } from './change-emitter';
import {
  buildAccessorChildren,
  subscribeAt,
  type AccessorBackend,
  type ConfigChildren,
} from './accessor';
import {
  emitAffected,
  flattenAt,
  valueAtPath,
  withRevertsUnder,
  type SchemaTree,
} from './utils';

/**
 * A batch of applied flat changes, handed to the owner for persistence + broadcast.
 * A value of `undefined` means the key reverted to its schema default — the persisted
 * override must be deleted.
 */
export type ApplyListener = (changes: ReadonlyMap<string, ConfigValue | undefined>) => void;

/**
 * The server scope as `define()` hands it out: the scope's own verbs plus the materialized
 * accessor node for every top-level schema key, so `config.server.economy.currency.get()`
 * type-checks alongside `config.server.get()`.
 *
 * The nodes are real own properties assigned in the constructor — TypeScript cannot see
 * properties produced by a schema walk, which is what this intersection states.
 */
export type ServerConfigTree<S extends Record<string, unknown>> = ServerConfigScope<S> & ConfigChildren<S>;

export class ServerConfigScope<S extends Record<string, unknown>> {
  private readonly _tree: SchemaTree;
  private readonly _flatSchema: FlatSchema;
  private readonly _values: Map<string, ConfigValue>;
  private readonly _emitter = new ChangeEmitter();
  private readonly _onApply: ApplyListener;
  private readonly _backend: AccessorBackend;

  readonly schema: FlatSchema;

  constructor(
    tree: SchemaTree,
    flatSchema: FlatSchema,
    values: Map<string, ConfigValue>,
    onApply: ApplyListener,
  ) {
    this._tree = tree;
    this._flatSchema = flatSchema;
    this._values = values;
    this._onApply = onApply;
    this.schema = flatSchema;
    this._backend = {
      read: (path): unknown => valueAtPath(this._tree, path, this._flatSchema, this._values),
      patch: (path, value): void => { this.applyAndEmit(flattenAt(path, value)); },
      replace: (path, value): void => { this.applyAndEmit(withRevertsUnder(path, flattenAt(path, value), this._flatSchema)); },
      on: (path, listener): Unsubscribe => this._emitter.on(path, listener),
    };

    // Materialized here, once: the schema is fully known at registration, so the whole tree is
    // built up front and every later `config.server.a.b.get()` is a plain property lookup.
    const children = buildAccessorChildren(tree, '', this._backend);

    // The tree is assigned ONTO the scope, so a top-level key that matches any member of this
    // class would silently overwrite it. `validateConfigSchema` already rejects the documented
    // verbs with a better message; this catches everything else (`schema` and the transport
    // methods) and keeps covering new members automatically as they are added.
    for (const key of Object.keys(children)) {
      if (key in this) {
        throw new Error(
          `config schema: top-level server key "${key}" collides with a config scope member of the same name — rename it`,
        );
      }
    }

    Object.assign(this, children);
  }

  /** Return the full current config as a typed nested object. */
  get(): SchemaToValue<S> {
    // The tree walk reconstructs exactly the shape SchemaToValue<S> describes; TS cannot
    // verify an object assembled key-by-key at runtime, so this assertion is inherent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return this._backend.read('') as SchemaToValue<S>;
  }

  /** Deep-merge a partial update. Only the provided keys are changed. */
  patch(partial: DeepPartial<SchemaToValue<S>>): void {
    this._backend.patch('', partial);
  }

  /**
   * Replace the full config. Requires the whole object; every schema key not present in
   * the input reverts to its schema default and its persisted override is deleted.
   */
  set(value: SchemaToValue<S>): void {
    this._backend.replace('', value);
  }

  /**
   * Watch the whole scope, or one dot-path within it. The path form is the escape hatch for
   * paths computed at runtime — when the path is a literal, prefer the node it names
   * (`config.server.economy.currency.subscribe(...)`), which needs no path at all.
   */
  subscribe(listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
  subscribe<P extends DotPath<S>>(path: P, listener: ChangeListener<PathValue<S, P>>): Unsubscribe;
  subscribe(pathOrListener: string | ChangeListener<unknown>, listener?: ChangeListener<unknown>): Unsubscribe {
    return subscribeAt(this._backend, '', pathOrListener, listener);
  }

  /**
   * @internal Load persisted values (deferred one tick from `define()`). Emits change
   * events for keys whose loaded value differs from what reads returned so far, so a
   * subscriber attached right after `define()` still learns the real values. Does not
   * persist or broadcast.
   */
  loadInitial(values: Map<string, ConfigValue>): void {
    const prev = new Map(this._values);
    const changed: string[] = [];

    for (const [key, value] of values) {
      if (this._values.get(key) !== value) { changed.push(key); }

      this._values.set(key, value);
    }

    if (changed.length > 0) {
      emitAffected(this._emitter, changed, this._tree, this._flatSchema, this._values, prev);
    }
  }

  /** @internal All effective flat values (used for RPC responses). */
  getFlat(): Record<string, ConfigValue> {
    return Object.fromEntries(this._values);
  }

  /** @internal Apply a remote merge-patch from RPC (fires change events). */
  applyRemotePatch(flat: Record<string, ConfigValue>): void {
    this.applyAndEmit(new Map(Object.entries(flat)));
  }

  /** @internal Apply a remote full replace from RPC (fires change events). */
  applyRemoteSet(flat: Record<string, ConfigValue>): void {
    this.applyAndEmit(withRevertsUnder('', new Map(Object.entries(flat)), this._flatSchema));
  }

  private applyAndEmit(changes: Map<string, ConfigValue | undefined>): void {
    if (!changes.size) { return; }

    const prev = new Map(this._values);

    for (const [key, value] of changes) {
      if (value !== undefined) {
        this._values.set(key, value);
        continue;
      }

      const fallback = this._flatSchema[key]?.default;

      if (fallback !== undefined) { this._values.set(key, fallback); }
    }

    this._onApply(changes);
    emitAffected(this._emitter, changes.keys(), this._tree, this._flatSchema, this._values, prev);
  }
}
