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
import { buildTreeValue, emitAffected, flattenObject, type SchemaTree } from './utils';

/**
 * A batch of applied flat changes, handed to the owner for persistence + broadcast.
 * A value of `undefined` means the key reverted to its schema default — the persisted
 * override must be deleted.
 */
export type ApplyListener = (changes: ReadonlyMap<string, ConfigValue | undefined>) => void;

export class ServerConfigScope<S extends Record<string, unknown>> {
  private readonly _tree: SchemaTree;
  private readonly _flatSchema: FlatSchema;
  private readonly _values: Map<string, ConfigValue>;
  private readonly _emitter = new ChangeEmitter();
  private readonly _onApply: ApplyListener;

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
  }

  /** Return the full current config as a typed nested object. */
  get(): SchemaToValue<S> {
    // The tree walk reconstructs exactly the shape SchemaToValue<S> describes; TS cannot
    // verify an object assembled key-by-key at runtime, so this assertion is inherent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return buildTreeValue(this._tree, '', this._flatSchema, this._values) as SchemaToValue<S>;
  }

  /** Deep-merge a partial update. Only the provided keys are changed. */
  patch(partial: DeepPartial<SchemaToValue<S>>): void {
    this.applyAndEmit(flattenObject(partial));
  }

  /**
   * Replace the full config. Requires the whole object; every schema key not present in
   * the input reverts to its schema default and its persisted override is deleted.
   */
  set(value: SchemaToValue<S>): void {
    this.applyAndEmit(this.withReverts(flattenObject(value)));
  }

  onChange(listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
  onChange<P extends DotPath<S>>(path: P, listener: ChangeListener<PathValue<S, P>>): Unsubscribe;
  onChange(pathOrListener: string | ChangeListener<unknown>, listener?: ChangeListener<unknown>): Unsubscribe {
    if (typeof pathOrListener === 'function') {
      return this._emitter.on('', pathOrListener);
    }

    if (!listener) { throw new Error('onChange(path, listener): listener is required'); }

    return this._emitter.on(pathOrListener, listener);
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

  /** @internal Apply a remote merge-patch from RPC (fires change events). */
  applyRemotePatch(flat: Record<string, ConfigValue>): void {
    this.applyAndEmit(new Map(Object.entries(flat)));
  }

  /** @internal Apply a remote full replace from RPC (fires change events). */
  applyRemoteSet(flat: Record<string, ConfigValue>): void {
    this.applyAndEmit(this.withReverts(new Map(Object.entries(flat))));
  }

  /** Mark every schema key missing from `changes` as a revert-to-default. */
  private withReverts(changes: Map<string, ConfigValue>): Map<string, ConfigValue | undefined> {
    const full = new Map<string, ConfigValue | undefined>(changes);

    for (const key of Object.keys(this._flatSchema)) {
      if (!full.has(key)) { full.set(key, undefined); }
    }

    return full;
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
