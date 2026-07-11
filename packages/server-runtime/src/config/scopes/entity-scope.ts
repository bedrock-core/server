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
import { flattenObject, collectAffectedPaths, parseListValue } from './utils';

/**
 * Generic per-entity config scope — works for any entity with an `id` string
 * (`Dimension`, `Player`, etc.).
 *
 * Value resolution: per-entity stored value → schema default.
 */
export class EntityConfigScope<S extends Record<string, unknown>, E extends { id: string }> {
  private readonly tree: Record<string, SchemaNode>;
  private readonly flatSchema: FlatSchema;
  private readonly values: Map<string, Map<string, ConfigValue>>;
  private readonly emitters = new Map<string, ChangeEmitter>();
  private readonly onWrite: (entityId: string, key: string, value: ConfigValue) => void;

  readonly schema: FlatSchema;

  constructor(
    tree: Record<string, SchemaNode>,
    flatSchema: FlatSchema,
    values: Map<string, Map<string, ConfigValue>>,
    onWrite: (entityId: string, key: string, value: ConfigValue) => void,
  ) {
    this.tree = tree;
    this.flatSchema = flatSchema;
    this.values = values;
    this.onWrite = onWrite;
    this.schema = flatSchema;
  }

  /** Return the full current config for an entity as a typed nested object. */
  get(entity: E): SchemaToValue<S> {
    return this.typedValue(this.values.get(entity.id) ?? new Map());
  }

  /** Deep-merge a partial update for a specific entity. */
  patch(entity: E, partial: DeepPartial<SchemaToValue<S>>): void {
    this.applyForEntity(entity.id, flattenObject(partial));
  }

  /** Replace the full config for a specific entity. */
  set(entity: E, value: SchemaToValue<S>): void {
    this.applyForEntity(entity.id, flattenObject(value));
  }

  onChange(entity: E, listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
  onChange<P extends DotPath<S>>(entity: E, path: P, listener: ChangeListener<PathValue<S, P>>): Unsubscribe;
  onChange(entity: E, pathOrListener: string | ChangeListener<unknown>, listener?: ChangeListener<unknown>): Unsubscribe {
    const emitter = this.emitterFor(entity.id);

    if (typeof pathOrListener === 'function') {
      return emitter.on('', pathOrListener);
    }

    if (!listener) { throw new Error('onChange(entity, path, listener): listener is required'); }

    return emitter.on(pathOrListener, listener);
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

  /** @internal Apply a remote patch for an entity from RPC (fires change events). */
  applyRemotePatch(entityId: string, flat: Record<string, ConfigValue>): void {
    this.applyForEntity(entityId, new Map(Object.entries(flat)));
  }

  /** @internal Return all effective flat values for an entity (used for RPC response). */
  getFlat(entityId: string): Record<string, ConfigValue> {
    const entityMap = this.values.get(entityId);
    const result: Record<string, ConfigValue> = {};

    for (const key of Object.keys(this.flatSchema)) {
      result[key] = entityMap?.get(key) ?? this.flatSchema[key]?.default;
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

      const newVal = this.valueAt(path, entityMap);
      const prevVal = this.valueAt(path, prev);

      emitter.emit(path, newVal, prevVal);
    }
  }

  private valueAt(path: string, entityValues: Map<string, ConfigValue>): unknown {
    if (path === '') { return this.buildTree(this.tree, '', entityValues); }

    return this.reconstruct(path, entityValues);
  }

  private reconstruct(path: string, entityValues: Map<string, ConfigValue>): unknown {
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

    if (isEntry(node)) { return this.resolveLeaf(nodePath, entityValues); }

    return this.buildTree(node, nodePath, entityValues);
  }

  private buildTree(
    subtree: Record<string, SchemaNode>,
    prefix: string,
    entityValues: Map<string, ConfigValue>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, node] of Object.entries(subtree)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (isEntry(node)) {
        result[key] = this.resolveLeaf(path, entityValues);
      } else {
        result[key] = this.buildTree(
          node, path, entityValues,
        );
      }
    }

    return result;
  }

  private resolveLeaf(path: string, entityValues: Map<string, ConfigValue>): unknown {
    const raw = entityValues.get(path) ?? this.flatSchema[path]?.default;

    if (this.flatSchema[path]?.type === 'list' && typeof raw === 'string') {
      return parseListValue(raw);
    }

    return raw;
  }

  private typedValue(entityValues: Map<string, ConfigValue>): SchemaToValue<S> {
    // The tree walk reconstructs exactly the shape SchemaToValue<S> describes; TS cannot
    // verify an object assembled key-by-key at runtime, so this assertion is inherent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return this.buildTree(this.tree, '', entityValues) as SchemaToValue<S>;
  }

  private emitterFor(entityId: string): ChangeEmitter {
    let e = this.emitters.get(entityId);

    if (!e) { e = new ChangeEmitter(); this.emitters.set(entityId, e); }

    return e;
  }
}
