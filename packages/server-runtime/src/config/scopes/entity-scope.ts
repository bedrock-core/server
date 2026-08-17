import type { Unsubscribe } from '@bedrock-core/sync';
import type {
  ConfigValue,
  FlatSchema,
  SchemaToValue,
  DeepPartial,
} from '../schema';
import { ChangeEmitter } from './change-emitter';
import { buildAccessorNode, type AccessorBackend, type ConfigTree } from './accessor';
import {
  buildTreeValue,
  emitAffected,
  flattenAt,
  flattenObject,
  valueAtPath,
  withRevertsUnder,
  type SchemaTree,
} from './utils';

/**
 * A batch of applied flat changes for one entity, handed to the owner for persistence +
 * broadcast. A value of `undefined` means the key reverted to its schema default — the
 * persisted per-entity override must be deleted.
 */
export type EntityApplyListener = (entityId: string, changes: ReadonlyMap<string, ConfigValue | undefined>) => void;

/**
 * Generic per-entity config scope — works for any entity with an `id` string
 * (`Dimension`, `Player`, etc.).
 *
 * Value resolution: per-entity stored value → schema default.
 *
 * {@link EntityConfigScope.for} is the way in: it returns the same accessor tree the server
 * scope is, bound to one entity, so both scopes read identically past that point
 * (`config.player.for(player).notify.onLogin.get()`). The entity-first `get` / `patch` / `set`
 * remain for callers holding an untyped scope, such as `core.config.local`.
 */
export class EntityConfigScope<S extends Record<string, unknown>, E extends { id: string }> {
  private readonly _tree: SchemaTree;
  private readonly _flatSchema: FlatSchema;
  private readonly _values: Map<string, Map<string, ConfigValue>>;
  private readonly _emitters = new Map<string, ChangeEmitter>();
  private readonly _trees = new Map<string, ConfigTree<S>>();
  private readonly _onApply: EntityApplyListener;

  readonly schema: FlatSchema;

  constructor(
    tree: SchemaTree,
    flatSchema: FlatSchema,
    values: Map<string, Map<string, ConfigValue>>,
    onApply: EntityApplyListener,
  ) {
    this._tree = tree;
    this._flatSchema = flatSchema;
    this._values = values;
    this._onApply = onApply;
    this.schema = flatSchema;
  }

  /**
   * The accessor tree for one entity — the same shape the server scope has, so everything
   * past this call reads identically across scopes:
   *
   * ```ts
   * config.player.for(player).notify.onLogin.get()
   * config.player.for(player).notify.onLogin.subscribe(cb)
   * config.player.for(player).get()                       // the whole scope for that player
   * config.player.for(player).subscribe('notify.onLogin', cb)
   * ```
   *
   * Trees are cached per entity id and dropped in {@link clear}. Caching cannot go stale: a
   * node stores nothing, it resolves values and its emitter through this scope by id on every
   * call — so a tree obtained before a rejoin keeps working, and only the walk is saved.
   */
  for(entity: E): ConfigTree<S> {
    let tree = this._trees.get(entity.id);

    if (!tree) { tree = this.buildTree(entity.id); this._trees.set(entity.id, tree); }

    return tree;
  }

  /** Return the full current config for an entity as a typed nested object. */
  get(entity: E): SchemaToValue<S> {
    // The tree walk reconstructs exactly the shape SchemaToValue<S> describes; TS cannot
    // verify an object assembled key-by-key at runtime, so this assertion is inherent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return buildTreeValue(this._tree, '', this._flatSchema, this.valuesFor(entity.id)) as SchemaToValue<S>;
  }

  /** Deep-merge a partial update for a specific entity. Only the provided keys are changed. */
  patch(entity: E, partial: DeepPartial<SchemaToValue<S>>): void {
    this.applyForEntity(entity.id, flattenObject(partial));
  }

  /**
   * Replace the full config for a specific entity. Requires the whole object; every schema
   * key not present in the input reverts to its schema default and its persisted per-entity
   * override is deleted.
   */
  set(entity: E, value: SchemaToValue<S>): void {
    this.applyForEntity(entity.id, withRevertsUnder('', flattenObject(value), this._flatSchema));
  }

  /** @internal Load initial entity values on join. Does not emit (no listener can predate the entity). */
  init(entityId: string, entityValues: Map<string, ConfigValue>): void {
    this._values.set(entityId, entityValues);
  }

  /**
   * @internal Load persisted entity values (deferred one tick from `define()`). Emits change
   * events for keys whose loaded value differs from what reads returned so far. Does not
   * persist or broadcast.
   */
  loadInitial(entityId: string, loaded: Map<string, ConfigValue>): void {
    if (!loaded.size) { return; }

    const entityMap = this.ensureValues(entityId);
    const prev = new Map(entityMap);
    const changed: string[] = [];

    for (const [key, value] of loaded) {
      if (entityMap.get(key) !== value) { changed.push(key); }

      entityMap.set(key, value);
    }

    const emitter = this._emitters.get(entityId);

    if (emitter && changed.length > 0) {
      emitAffected(emitter, changed, this._tree, this._flatSchema, entityMap, prev);
    }
  }

  /** @internal Clear entity data on leave. */
  clear(entityId: string): void {
    this._values.delete(entityId);
    this._emitters.get(entityId)?.clear();
    this._emitters.delete(entityId);
    this._trees.delete(entityId);
  }

  /** @internal Apply a remote merge-patch for an entity from RPC (fires change events). */
  applyRemotePatch(entityId: string, flat: Record<string, ConfigValue>): void {
    this.applyForEntity(entityId, new Map(Object.entries(flat)));
  }

  /** @internal Apply a remote full replace for an entity from RPC (fires change events). */
  applyRemoteSet(entityId: string, flat: Record<string, ConfigValue>): void {
    this.applyForEntity(entityId, withRevertsUnder('', new Map(Object.entries(flat)), this._flatSchema));
  }

  /** @internal Return all effective flat values for an entity (used for RPC response). */
  getFlat(entityId: string): Record<string, ConfigValue> {
    const entityMap = this._values.get(entityId);
    const result: Record<string, ConfigValue> = {};

    for (const key of Object.keys(this._flatSchema)) {
      result[key] = entityMap?.get(key) ?? this._flatSchema[key]?.default;
    }

    return result;
  }

  /**
   * Walk the schema once for one entity. Every node closes over `entityId` and resolves values
   * and its emitter through this scope on each call, so the result never holds stale state.
   */
  private buildTree(entityId: string): ConfigTree<S> {
    const backend: AccessorBackend = {
      read: (path): unknown => valueAtPath(this._tree, path, this._flatSchema, this.valuesFor(entityId)),
      patch: (path, value): void => { this.applyForEntity(entityId, flattenAt(path, value)); },
      replace: (path, value): void => {
        this.applyForEntity(entityId, withRevertsUnder(path, flattenAt(path, value), this._flatSchema));
      },
      on: (path, listener): Unsubscribe => this.emitterFor(entityId).on(path, listener),
    };

    // The walk reproduces exactly the shape ConfigTree<S> describes; TS cannot verify an object
    // assembled key-by-key at runtime, so this assertion is inherent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return buildAccessorNode(this._tree, '', backend) as ConfigTree<S>;
  }

  private applyForEntity(entityId: string, changes: Map<string, ConfigValue | undefined>): void {
    if (!changes.size) { return; }

    const entityMap = this.ensureValues(entityId);
    const prev = new Map(entityMap);

    for (const [key, value] of changes) {
      if (value !== undefined) {
        entityMap.set(key, value);
      } else {
        entityMap.delete(key);
      }
    }

    this._onApply(entityId, changes);

    const emitter = this._emitters.get(entityId);

    if (emitter) {
      emitAffected(emitter, changes.keys(), this._tree, this._flatSchema, entityMap, prev);
    }
  }

  private valuesFor(entityId: string): Map<string, ConfigValue> {
    return this._values.get(entityId) ?? new Map<string, ConfigValue>();
  }

  private ensureValues(entityId: string): Map<string, ConfigValue> {
    let entityMap = this._values.get(entityId);

    if (!entityMap) { entityMap = new Map(); this._values.set(entityId, entityMap); }

    return entityMap;
  }

  private emitterFor(entityId: string): ChangeEmitter {
    let e = this._emitters.get(entityId);

    if (!e) { e = new ChangeEmitter(); this._emitters.set(entityId, e); }

    return e;
  }
}
