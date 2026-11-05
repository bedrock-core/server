import { Block, Dimension, Entity, world } from '@minecraft/server';
export type ResultKind = 'data' | 'entity' | 'dimension' | 'block' | 'native';
type Root = {
  kind: 'entity' | 'dimension';
  id: string;
} | {
  kind: 'block';
  dimension: string;
  x: number;
  y: number;
  z: number;
} | {
  kind: 'world';
};
type Step = {
  operation: string;
  args: (string | number)[];
};
export interface Recipe {
  version: 1;
  root: Root;
  path: Step[];
}

/** A valid lookup whose Minecraft owner or inventory is currently unavailable. */
export class NativeLookupUnavailableError extends Error {}
type Origin = { root: Root } | { parent: Origin; operation: string; argument?: string | number } | { blocked: string };
interface InventoryOrigin {
  operation: string;
  origin: Origin;
  slots: (Origin | undefined)[];
}
type NativeFunction = (...args: never[]) => unknown;
type NativeConstructor = new (...args: never[]) => object;
interface Bound {
  receiver: unknown;
  prefix: unknown[];
  operation?: string;
}

export interface NativeAccess {
  call(receiver: unknown, key: string, args: unknown[], operation: string, kind: ResultKind): unknown;
  call1(receiver: unknown, key: string, argument: unknown, operation: string, kind: ResultKind): unknown;
  get(receiver: unknown, key: string, operation: string, kind: ResultKind): unknown;
  inventorySlot(receiver: unknown, argument: unknown, operation: string, deferred?: boolean): unknown;
  encode(value: unknown): Recipe;
  decode(input: unknown): unknown;
  bind(fn: NativeFunction, receiver: unknown, prefix: unknown[], operation?: string, key?: string): NativeFunction;
  invoke(fn: NativeFunction, receiver: unknown, args: unknown[], operation: string, kind: ResultKind, key?: string): unknown;
  construct(ctor: NativeConstructor, args: unknown[], operation: string): unknown;
  set(receiver: unknown, key: string, value: unknown): unknown;
}
const lookup = new Set(['Entity.getComponent', 'EntityInventoryComponent.container', 'Block.getComponent', 'BlockInventoryComponent.container', 'Container.getSlot']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function callable(value: unknown): value is NativeFunction {
  return typeof value === 'function';
}

function readMember(receiver: unknown, key: string): unknown {
  if (receiver === undefined || receiver === null) { throw new TypeError('native lookup receiver is unavailable'); }

  const target: object = Object(receiver);

  return Reflect.get(target, key, receiver);
}

function method(receiver: unknown, key: string): NativeFunction {
  const value = readMember(receiver, key);

  if (!callable(value)) { throw new TypeError(`native member ${key} is not callable`); }

  return value;
}

function evaluate(value: unknown): unknown {
  if (!callable(value)) { throw new TypeError('native lookup argument is not callable'); }

  return value();
}

/** Private lookup provenance. Values returned to authored code remain real native objects. */
export function createNativeAccess(): NativeAccess {
  const origins = new WeakMap<object, Origin>();
  const inventoryOrigins = new WeakMap<Origin, InventoryOrigin>();
  const bound = new WeakMap<NativeFunction, Bound>();

  const anchor = (value: unknown): Root | undefined => {
    if (value === world) {
      return { kind: 'world' };
    }

    if (value instanceof Entity) {
      return { kind: 'entity', id: value.id };
    }

    if (value instanceof Dimension) {
      return { kind: 'dimension', id: value.id };
    }

    if (value instanceof Block) {
      return { kind: 'block', dimension: value.dimension.id, ...value.location };
    }

    return undefined;
  };

  const origin = (value: unknown): Origin | undefined => {
    if (!record(value)) {
      return;
    }

    const existing = origins.get(value);

    if (existing) {
      return existing;
    }

    const root = anchor(value);

    if (root) {
      const found = { root };

      origins.set(value, found);

      return found;
    }

    return undefined;
  };

  const capture = <T>(value: T, receiver: unknown, operation: string, argument: unknown, kind: ResultKind, count: number): T => {
    if (!record(value) || kind === 'data') {
      return value;
    }

    if ((value as unknown) === world) {
      origins.set(value, { root: { kind: 'world' } });

      return value;
    }

    if (kind !== 'native') {
      const root = anchor(value);

      if (root) {
        origins.set(value, { root });

        return value;
      }
    }

    const parent = origin(receiver);

    if (lookup.has(operation) && parent && !('blocked' in parent) && count <= 1
      && (argument === undefined || typeof argument === 'string' || typeof argument === 'number')) {
      origins.set(value, { parent, operation, argument });
    } else {
      origins.set(value, { blocked: lookup.has(operation) ? `untracked parent for ${operation}` : `non-replayable native result: ${operation}` });
    }

    return value;
  };

  const call = (receiver: unknown, key: string, args: unknown[], operation: string, kind: ResultKind): unknown => {
    const fn = method(receiver, key);
    const value = Reflect.apply(fn, receiver, args);
    const selected = operation || inferred(receiver, key);

    return selected ? capture(value, receiver, selected, args[0], kind, args.length) : value;
  };

  const call1 = (receiver: unknown, key: string, argument: unknown, operation: string, kind: ResultKind): unknown => {
    const value = Reflect.apply(method(receiver, key), receiver, [argument]);

    return capture(value, receiver, operation, argument, kind, 1);
  };

  const get = (receiver: unknown, key: string, operation: string, kind: ResultKind): unknown => {
    const value = readMember(receiver, key);
    const selected = operation || inferred(receiver, key);

    return selected ? capture(value, receiver, selected, undefined, kind, 0) : value;
  };

  const inferred = (receiver: unknown, key: string): string | undefined => {
    const found = origin(receiver);

    if (!found || 'blocked' in found) {
      return;
    }

    const type = 'root' in found ? found.root.kind : found.operation;

    if (key === 'getComponent' && (type === 'entity' || type === 'block')) {
      return type === 'entity' ? 'Entity.getComponent' : 'Block.getComponent';
    }

    if (key === 'container' && (type === 'Entity.getComponent' || type === 'Block.getComponent')) {
      return type === 'Entity.getComponent' ? 'EntityInventoryComponent.container' : 'BlockInventoryComponent.container';
    }

    if (key === 'getSlot' && (type === 'EntityInventoryComponent.container' || type === 'BlockInventoryComponent.container')) {
      return 'Container.getSlot';
    }

    return undefined;
  };

  const foreignInventorySlot = (receiver: unknown, component: unknown, argument: unknown, operation: string, deferred: boolean): unknown => {
    const first = operation || inferred(receiver, 'getComponent');

    if (first) { capture(component, receiver, first, 'minecraft:inventory', 'native', 1); }

    const container = get(component, 'container', operation
      ? operation === 'Entity.getComponent' ? 'EntityInventoryComponent.container' : 'BlockInventoryComponent.container'
      : '', 'native');
    const fn = method(container, 'getSlot');
    const index = deferred ? evaluate(argument) : argument;
    const value = Reflect.apply(fn, container, [index]);
    const last = operation ? 'Container.getSlot' : inferred(container, 'getSlot');

    return last ? capture(value, container, last, index, 'native', 1) : value;
  };

  /** Capture a contiguous inventory chain without retaining intermediate native objects. */
  const inventorySlot = (receiver: unknown, argument: unknown, operation: string, deferred = true): unknown => {
    if (!(receiver instanceof Entity) && !(receiver instanceof Block)) {
      const component = Reflect.apply(method(receiver, 'getComponent'), receiver, ['minecraft:inventory']);

      return foreignInventorySlot(receiver, component, argument, operation, deferred);
    }

    const component = receiver.getComponent('minecraft:inventory')!;
    const parent = origins.get(receiver) ?? origin(receiver);
    let inventory = parent && inventoryOrigins.get(parent);

    if (!inventory || (operation && operation !== inventory.operation)) {
      const type = parent && 'root' in parent ? parent.root.kind : undefined;
      const selected = type === 'entity' ? 'Entity.getComponent' : type === 'block' ? 'Block.getComponent' : undefined;

      if (!parent || !selected || (operation && operation !== selected)) {
        return foreignInventorySlot(receiver, component, argument, operation, deferred);
      }

      inventory = { operation: selected, slots: [], origin: {
        parent: { parent, operation: selected, argument: 'minecraft:inventory' },
        operation: type === 'entity' ? 'EntityInventoryComponent.container' : 'BlockInventoryComponent.container',
      } };
      inventoryOrigins.set(parent, inventory);
    }

    const container = component.container!;
    let index: unknown;
    const value: unknown = Reflect.apply(container.getSlot, container, [index = deferred ? evaluate(argument) : argument]);

    if (!record(value)) {
      return value;
    }

    if (index !== undefined && typeof index !== 'string' && typeof index !== 'number') {
      origins.set(value, { blocked: 'untracked parent for Container.getSlot' });

      return value;
    }

    // Bound recipe reuse only; every native component/container/slot lookup still executes.
    const cacheIndex = typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 64 ? index : undefined;
    let found = cacheIndex === undefined ? undefined : inventory.slots[cacheIndex];

    if (!found) {
      found = { parent: inventory.origin, operation: 'Container.getSlot', argument: index };

      if (cacheIndex !== undefined) {
        inventory.slots[cacheIndex] = found;
      }
    }

    origins.set(value, found);

    return value;
  };

  const encode = (value: unknown): Recipe => {
    const found = origin(value);

    if (!found || 'blocked' in found) {
      throw new Error(found && 'blocked' in found ? found.blocked : 'native object has no captured lookup path');
    }

    const path: Step[] = [];

    let current: Origin = found;

    while ('parent' in current) {
      path.push({ operation: current.operation, args: current.argument === undefined ? [] : [current.argument] });
      current = current.parent;
    }

    if (!('root' in current)) {
      throw new Error('native object has no captured lookup root');
    }

    return { version: 1, root: { ...current.root }, path: path.reverse() };
  };

  const decode = (input: unknown): unknown => {
    if (!record(input) || input.version !== 1 || !record(input.root) || !Array.isArray(input.path) || input.path.length > 16) {
      throw new TypeError('invalid native recipe');
    }

    const root = input.root;
    const steps: Step[] = input.path.map((step: unknown) => {
      if (!record(step) || typeof step.operation !== 'string' || !lookup.has(step.operation) || !Array.isArray(step.args)) {
        throw new TypeError('recipe contains a non-lookup operation');
      }

      const args: unknown[] = step.args;
      const getter = step.operation.endsWith('.container');
      const slot = step.operation === 'Container.getSlot';

      if ((getter && args.length !== 0) || (!getter && (args.length !== 1 || (slot ? typeof args[0] !== 'number' || !Number.isSafeInteger(args[0]) || args[0] < 0 : typeof args[0] !== 'string' || !args[0])))) {
        throw new TypeError('invalid native lookup arguments');
      }

      return { operation: step.operation, args: typeof args[0] === 'string' || typeof args[0] === 'number' ? [args[0]] : [] };
    });
    let value: unknown;

    if ((root.kind === 'entity' || root.kind === 'dimension') && typeof root.id === 'string' && root.id) {
      value = root.kind === 'entity' ? world.getEntity(root.id) : world.getDimension(root.id);
    } else if (root.kind === 'world') {
      value = world;
    } else if (root.kind === 'block' && typeof root.dimension === 'string' && typeof root.x === 'number' && typeof root.y === 'number' && typeof root.z === 'number' && [root.x, root.y, root.z].every(Number.isSafeInteger)) {
      value = world.getDimension(root.dimension).getBlock({ x: root.x, y: root.y, z: root.z });
    } else {
      throw new TypeError('invalid native root');
    }

    if (!record(value) || ('isValid' in value && value.isValid === false)) {
      throw new NativeLookupUnavailableError('native owner is unavailable');
    }

    const canonical = anchor(value);

    if (canonical) {
      origins.set(value, { root: canonical });
    }

    for (const step of steps) {
      const key = step.operation.slice(step.operation.indexOf('.') + 1);

      value = step.operation.endsWith('.container') ? get(value, key, step.operation, 'native') : call(value, key, step.args, step.operation, 'native');

      if (!record(value) || ('isValid' in value && value.isValid === false)) {
        throw new NativeLookupUnavailableError('native lookup is unavailable');
      }
    }

    return value;
  };

  return {
    call, call1, get, inventorySlot, encode, decode,
    bind(fn: NativeFunction, receiver: unknown, prefix: unknown[], operation = '', key = ''): NativeFunction {
      const result: unknown = Reflect.apply(Function.prototype.bind, fn, [receiver, ...prefix]);

      if (!callable(result)) { throw new TypeError('native method binding did not return a function'); }

      const saved = bound.get(fn);
      const owner = saved ? saved.receiver : receiver;

      bound.set(result, { receiver: owner, prefix: saved ? [...saved.prefix, ...prefix] : prefix, operation: saved?.operation || operation || inferred(owner, key) });

      return result;
    },
    invoke(fn: NativeFunction, receiver: unknown, args: unknown[], operation: string, kind: ResultKind, key = ''): unknown {
      const saved = bound.get(fn);
      const owner = saved?.receiver ?? receiver;
      const value = Reflect.apply(fn, receiver, args);
      const selected = saved?.operation || operation || inferred(owner, key);

      const prefix = saved?.prefix ?? [];

      return selected ? capture(value, owner, selected, prefix.length ? prefix[0] : args[0], kind, prefix.length + args.length) : value;
    },
    construct(ctor: NativeConstructor, args: unknown[], operation: string): unknown {
      return capture(Reflect.construct(ctor, args), undefined, operation, args[0], 'native', args.length);
    },
    set(receiver: unknown, key: string, value: unknown): unknown {
      if (!record(receiver)) {
        throw new TypeError('invalid native setter receiver');
      }

      if (!Reflect.set(receiver, key, value, receiver)) {
        throw new TypeError('native setter failed');
      }

      return value;
    },
  };
}

export const nativeAccess = createNativeAccess();
