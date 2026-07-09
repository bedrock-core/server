import type { Unsubscribe } from '@bedrock-core/sync';
import type {
  ConfigValue,
  FlatSchema,
  SchemaNode,
  SchemaToValue,
  DotPath,
  PathValue,
  DeepPartial,
} from '../schema';
import { isEntry } from '../schema';
import { ChangeEmitter, type ChangeListener } from './change-emitter';
import { flattenObject, collectAffectedPaths } from './utils';

/**
 * Generic per-entity config scope — works for any entity with an `id` string
 * (`Dimension`, `Player`, etc.).
 *
 * Value resolution: per-entity stored value → entity-type default → schema default.
 */
export class EntityConfigScope<S extends Record<string, unknown>, E extends { id: string }> {
  private readonly tree: Record<string, SchemaNode>;
  private readonly flatSchema: FlatSchema;
  private readonly defaults: Map<string, ConfigValue>;
  private readonly values: Map<string, Map<string, ConfigValue>>;
  private readonly emitters = new Map<string, ChangeEmitter>();
  private readonly onWrite: (entityId: string, key: string, value: ConfigValue) => void;
  private readonly onWriteDefault: (key: string, value: ConfigValue) => void;

  readonly schema: FlatSchema;

  constructor(
    tree: Record<string, SchemaNode>,
    flatSchema: FlatSchema,
    defaults: Map<string, ConfigValue>,
    values: Map<string, Map<string, ConfigValue>>,
    onWrite: (entityId: string, key: string, value: ConfigValue) => void,
    onWriteDefault: (key: string, value: ConfigValue) => void,
  ) {
    this.tree = tree;
    this.flatSchema = flatSchema;
    this.defaults = defaults;
    this.values = values;
    this.onWrite = onWrite;
    this.onWriteDefault = onWriteDefault;
    this.schema = flatSchema;
  }

  /** Return the full current config for an entity as a typed nested object. */
  get(entity: E): SchemaToValue<S> {
    return this.buildTree(
      this.tree, '', this.values.get(entity.id) ?? new Map(), this.defaults,
    ) as SchemaToValue<S>;
  }

  /** Deep-merge a partial update for a specific entity. */
  patch(entity: E, partial: DeepPartial<SchemaToValue<S>>): void {
    this.applyForEntity(entity.id, flattenObject(partial));
  }

  /** Replace the full config for a specific entity. */
  set(entity: E, value: SchemaToValue<S>): void {
    this.applyForEntity(entity.id, flattenObject(value));
  }

  /** Return the current entity-type defaults as a typed nested object. */
  getDefault(): SchemaToValue<S> {
    return this.buildTree(this.tree, '', new Map(), this.defaults) as SchemaToValue<S>;
  }

  /** Deep-merge a partial update to the entity-type defaults. */
  patchDefault(partial: DeepPartial<SchemaToValue<S>>): void {
    this.applyDefault(flattenObject(partial));
  }

  /** Replace the full entity-type defaults. */
  setDefault(value: SchemaToValue<S>): void {
    this.applyDefault(flattenObject(value));
  }

  onChange(entity: E, listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
  onChange<P extends DotPath<S>>(entity: E, path: P, listener: ChangeListener<PathValue<S, P>>): Unsubscribe;
  onChange(entity: E, pathOrListener: unknown, listener?: unknown): Unsubscribe {
    const emitter = this.emitterFor(entity.id);

    if (typeof pathOrListener === 'function') {
      return emitter.on('', pathOrListener as ChangeListener<unknown>);
    }

    return emitter.on(pathOrListener as string, listener as ChangeListener<unknown>);
  }

  /** @internal Load initial entity values on join. Does not emit. */
  init(entityId: string, entityValues: Map<string, ConfigValue>): void {
    this.values.set(entityId, entityValues);
  }

  /** @internal Clear entity data on leave. */
  clear(entityId: string): void {
    this.values.delete(entityId);
    this.emitters.get(entityId)?.clear();
    this.emitters.delete(entityId);
  }

  /** @internal Merge defaults loaded from DPs at tick 1. Does not emit. */
  applyDefaults(loadedDefaults: Map<string, ConfigValue>): void {
    for (const [key, value] of loadedDefaults) { this.defaults.set(key, value); }
  }

  /** @internal Apply a remote patch for an entity from RPC (fires change events). */
  applyRemotePatch(entityId: string, flat: Record<string, ConfigValue>): void {
    this.applyForEntity(entityId, new Map(Object.entries(flat)));
  }

  /** @internal Return all effective flat values for an entity (used for RPC response). */
  getFlat(entityId: string): Record<string, ConfigValue> {
    const entityMap = this.values.get(entityId);
    const result: Record<string, ConfigValue> = {};

    for (const key of Object.keys(this.flatSchema)) {
      result[key] = entityMap?.get(key) ?? this.defaults.get(key) ?? this.flatSchema[key]?.default;
    }

    return result;
  }

  private applyForEntity(entityId: string, changes: Map<string, ConfigValue>): void {
    if (!changes.size) { return; }

    let entityMap = this.values.get(entityId);

    if (!entityMap) { entityMap = new Map(); this.values.set(entityId, entityMap); }

    const prev = new Map(entityMap);

    for (const [key, value] of changes) {
      entityMap.set(key, value);
      this.onWrite(entityId, key, value);
    }

    const emitter = this.emitters.get(entityId);

    if (!emitter?.hasAny()) { return; }

    for (const path of collectAffectedPaths(changes)) {
      if (!emitter.has(path)) { continue; }

      const newVal = this.valueAt(path, entityMap, this.defaults);
      const prevVal = this.valueAt(path, prev, this.defaults);

      emitter.emit(path, newVal, prevVal);
    }
  }

  private applyDefault(changes: Map<string, ConfigValue>): void {
    if (!changes.size) { return; }

    const prevDefaults = new Map(this.defaults);

    for (const [key, value] of changes) {
      this.defaults.set(key, value);
      this.onWriteDefault(key, value);
    }

    for (const [entityId, emitter] of this.emitters) {
      if (!emitter.hasAny()) { continue; }

      const entityMap = this.values.get(entityId) ?? new Map<string, ConfigValue>();
      const effectiveChanges = new Map<string, ConfigValue>();

      for (const [key, value] of changes) {
        if (!entityMap.has(key)) { effectiveChanges.set(key, value); }
      }

      if (!effectiveChanges.size) { continue; }

      for (const path of collectAffectedPaths(effectiveChanges)) {
        if (!emitter.has(path)) { continue; }

        const newVal = this.valueAt(path, entityMap, this.defaults);
        const prevVal = this.valueAt(path, entityMap, prevDefaults);

        emitter.emit(path, newVal, prevVal);
      }
    }
  }

  private valueAt(
    path: string,
    entityValues: Map<string, ConfigValue>,
    entityDefaults: Map<string, ConfigValue>,
  ): unknown {
    if (path === '') { return this.buildTree(this.tree, '', entityValues, entityDefaults); }

    return this.reconstruct(path, entityValues, entityDefaults);
  }

  private reconstruct(
    path: string,
    entityValues: Map<string, ConfigValue>,
    entityDefaults: Map<string, ConfigValue>,
  ): unknown {
    const parts = path.split('.');
    let subtree: Record<string, SchemaNode> = this.tree;
    let prefix = '';

    for (let i = 0; i < parts.length - 1; i++) {
      const node = subtree[parts[i]];

      if (!node || isEntry(node)) { return undefined; }

      prefix = prefix ? `${prefix}.${parts[i]}` : parts[i];
      subtree = node;
    }

    const last = parts[parts.length - 1];
    const node = subtree[last];

    if (!node) { return undefined; }

    const nodePath = prefix ? `${prefix}.${last}` : last;

    if (isEntry(node)) { return this.resolveLeaf(nodePath, entityValues, entityDefaults); }

    return this.buildTree(node, nodePath, entityValues, entityDefaults);
  }

  private buildTree(
    subtree: Record<string, SchemaNode>,
    prefix: string,
    entityValues: Map<string, ConfigValue>,
    entityDefaults: Map<string, ConfigValue>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, node] of Object.entries(subtree)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (isEntry(node)) {
        result[key] = this.resolveLeaf(path, entityValues, entityDefaults);
      } else {
        result[key] = this.buildTree(
          node, path, entityValues, entityDefaults,
        );
      }
    }

    return result;
  }

  private resolveLeaf(
    path: string,
    entityValues: Map<string, ConfigValue>,
    entityDefaults: Map<string, ConfigValue>,
  ): unknown {
    const raw = entityValues.get(path) ?? entityDefaults.get(path) ?? this.flatSchema[path]?.default;

    if (this.flatSchema[path]?.type === 'list' && typeof raw === 'string') {
      try { return JSON.parse(raw) as unknown[]; } catch { return []; }
    }

    return raw;
  }

  private emitterFor(entityId: string): ChangeEmitter {
    let e = this.emitters.get(entityId);

    if (!e) { e = new ChangeEmitter(); this.emitters.set(entityId, e); }

    return e;
  }
}
