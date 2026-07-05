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

export class ServerConfigScope<S extends Record<string, unknown>> {
  private readonly tree: Record<string, SchemaNode>;
  private readonly flatSchema: FlatSchema;
  private readonly values: Map<string, ConfigValue>;
  private readonly emitter = new ChangeEmitter();
  private readonly onWrite: (key: string, value: ConfigValue) => void;

  readonly schema: FlatSchema;

  constructor(
    tree: Record<string, SchemaNode>,
    flatSchema: FlatSchema,
    values: Map<string, ConfigValue>,
    onWrite: (key: string, value: ConfigValue) => void,
  ) {
    this.tree = tree;
    this.flatSchema = flatSchema;
    this.values = values;
    this.onWrite = onWrite;
    this.schema = flatSchema;
  }

  /** Return the full current config as a typed nested object. */
  get(): SchemaToValue<S> {
    return this.buildTree(this.tree, '', this.values) as SchemaToValue<S>;
  }

  /** Deep-merge a partial update. Only the provided keys are changed. */
  patch(partial: DeepPartial<SchemaToValue<S>>): void {
    this.applyAndEmit(flattenObject(partial));
  }

  /** Replace the full config. Equivalent to patching every key. */
  set(value: SchemaToValue<S>): void {
    this.applyAndEmit(flattenObject(value));
  }

  onChange(listener: ChangeListener<SchemaToValue<S>>): Unsubscribe;
  onChange<P extends DotPath<S>>(path: P, listener: ChangeListener<PathValue<S, P>>): Unsubscribe;
  onChange(pathOrListener: unknown, listener?: unknown): Unsubscribe {
    if (typeof pathOrListener === 'function') {
      return this.emitter.on('', pathOrListener as ChangeListener<unknown>);
    }

    return this.emitter.on(pathOrListener as string, listener as ChangeListener<unknown>);
  }

  /** @internal Load initial values from persistence. Does not emit. */
  loadInitial(values: Map<string, ConfigValue>): void {
    for (const [key, value] of values) { this.values.set(key, value); }
  }

  /** @internal Apply a remote patch from RPC (fires change events). */
  applyRemotePatch(flat: Record<string, ConfigValue>): void {
    this.applyAndEmit(new Map(Object.entries(flat)));
  }

  private applyAndEmit(changes: Map<string, ConfigValue>): void {
    if (!changes.size) { return; }

    const prev = new Map(this.values);

    for (const [key, value] of changes) {
      this.values.set(key, value);
      this.onWrite(key, value);
    }

    if (!this.emitter.hasAny()) { return; }

    for (const path of collectAffectedPaths(changes)) {
      if (!this.emitter.has(path)) { continue; }

      const newVal = this.valueAt(path, this.values);
      const prevVal = this.valueAt(path, prev);

      this.emitter.emit(path, newVal, prevVal);
    }
  }

  private valueAt(path: string, values: Map<string, ConfigValue>): unknown {
    if (path === '') { return this.buildTree(this.tree, '', values); }

    return this.reconstruct(path, values);
  }

  private reconstruct(path: string, values: Map<string, ConfigValue>): unknown {
    const parts = path.split('.');
    let subtree: Record<string, SchemaNode> = this.tree;
    let prefix = '';

    for (let i = 0; i < parts.length - 1; i++) {
      const node = subtree[parts[i]];

      if (!node || isEntry(node)) { return undefined; }

      prefix = prefix ? `${prefix}.${parts[i]}` : parts[i];
      subtree = node as Record<string, SchemaNode>;
    }

    const last = parts[parts.length - 1];
    const node = subtree[last];

    if (!node) { return undefined; }

    const nodePath = prefix ? `${prefix}.${last}` : last;

    if (isEntry(node)) { return this.resolveLeaf(nodePath, values); }

    return this.buildTree(node as Record<string, SchemaNode>, nodePath, values);
  }

  private buildTree(
    subtree: Record<string, SchemaNode>,
    prefix: string,
    values: Map<string, ConfigValue>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, node] of Object.entries(subtree)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (isEntry(node)) {
        result[key] = this.resolveLeaf(path, values);
      } else {
        result[key] = this.buildTree(node as Record<string, SchemaNode>, path, values);
      }
    }

    return result;
  }

  private resolveLeaf(path: string, values: Map<string, ConfigValue>): unknown {
    const raw = values.get(path) ?? this.flatSchema[path]?.default;

    if (this.flatSchema[path]?.type === 'list' && typeof raw === 'string') {
      try { return JSON.parse(raw) as unknown[]; } catch { return []; }
    }

    return raw;
  }
}
