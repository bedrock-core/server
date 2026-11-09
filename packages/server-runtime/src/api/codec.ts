import type { ApiCallShape, ApiDataShape, ApiParametersShape, ApiReferenceShape, NativeValue } from './types';
import { isRecord } from '../guards';
import { freezeData } from '@bedrock-core/sync/data';

/** Callback references are owned by the containing RPC call. */
export interface CallCallbacks {
  encode(fn: (...args: unknown[]) => unknown, shape: ApiCallShape): unknown;
  decode(value: unknown, shape: ApiCallShape): (...args: unknown[]) => Promise<unknown>;
}

/** Per-call callbacks and reference adapters for registered and portable API clients. */
export interface ApiDataContext {
  values?: {
    encode(value: unknown, kind: NativeValue): unknown;
    decode(value: unknown, kind: NativeValue): unknown;
  };
  callbacks?: CallCallbacks;
  references?: {
    encode(value: unknown, shape: ApiReferenceShape): unknown;
    decode(value: unknown, shape: ApiReferenceShape): unknown;
  };
}

/** Transform checked adapter branches while retaining the surrounding object graph. */
export function transformData(value: unknown, shape: ApiDataShape | undefined, direction: 'encode' | 'decode', context?: ApiDataContext): unknown {
  if (shape === undefined) { return value; }

  const plans = new WeakMap<object, ApiDataShape>();
  const copies = new WeakMap<object, unknown>();
  const object = (input: unknown): input is object => input !== null && (typeof input === 'object' || typeof input === 'function');

  const collect = (input: unknown, plan: ApiDataShape): void => {
    if (!object(input) || plans.has(input)) { return; }

    plans.set(input, plan);
    shapeChildren(input, plan, (item, child) => { if (child) { collect(item, child); } });
  };

  const convert = (input: unknown, fallback?: ApiDataShape): unknown => {
    const plan = object(input) ? plans.get(input) ?? fallback : fallback;

    if (object(input) && copies.has(input)) { return copies.get(input); }

    const remember = (result: unknown): unknown => {
      if (object(input)) { copies.set(input, result); }

      return result;
    };

    if (plan?.kind === 'reference') {
      if ((input === undefined || input === null) && plan.missing !== undefined) { return input; }

      if (context?.references === undefined) { throw new Error('API references require reference adapters'); }

      if (direction === 'encode') { return remember(context.references.encode(input, plan)); }

      const reference = context.references.decode(input, plan);

      if (reference !== undefined) { return remember(reference); }

      if (plan.missing !== undefined) { return remember(plan.missing === 'null' ? null : undefined); }

      throw new Error(`API ${plan.reference} reference is unavailable`);
    }

    if (input === undefined || input === null) { return input; }

    if (plan?.kind === 'native-value') {
      if (context?.values === undefined) { throw new Error('native API values require value adapters'); }

      return remember(direction === 'encode' ? context.values.encode(input, plan.value) : context.values.decode(input, plan.value));
    }

    if (plan?.kind === 'codec') {
      if (direction === 'encode') {
        const encoded = plan.codec.encode(input);

        if (encoded === undefined) { throw new TypeError('a value codec must encode defined data'); }

        return remember([encoded]);
      }

      if (!Array.isArray(input) || input.length !== 1) { throw new TypeError('invalid encoded API value'); }

      return remember(plan.codec.decode(input[0]));
    }

    if (plan?.kind === 'callback') {
      const callbacks = context?.callbacks;

      if (callbacks === undefined) { throw new Error('callbacks require an active API call'); }

      if (direction === 'decode') { return remember(callbacks.decode(input, plan)); }

      if (typeof input !== 'function') { throw new TypeError('expected an async API callback'); }

      return remember(callbacks.encode((...args: unknown[]): unknown => Reflect.apply(input, undefined, args), plan));
    }

    if (plan?.kind === 'map' && !(input instanceof Map)) { throw new TypeError('expected an API map'); }

    if (plan?.kind === 'set' && !(input instanceof Set)) { throw new TypeError('expected an API set'); }

    if ((plan?.kind === 'array' || plan?.kind === 'tuple') && !Array.isArray(input)) { throw new TypeError('expected an API array'); }

    if (plan?.kind === 'object' && (!isRecord(input) || Array.isArray(input))) { throw new TypeError('expected an API data object'); }

    if (input instanceof Map) {
      const result = new Map<unknown, unknown>();

      remember(result);

      for (const [key, item] of input) { result.set(convert(key, plan?.kind === 'map' ? plan.key : undefined), convert(item, plan?.kind === 'map' ? plan.value : undefined)); }

      return result;
    }

    if (input instanceof Set) {
      const result = new Set<unknown>();

      remember(result);

      for (const item of input) { result.add(convert(item, plan?.kind === 'set' ? plan.item : undefined)); }

      return result;
    }

    if ((!isRecord(input) && !Array.isArray(input)) || input instanceof Date || input instanceof RegExp || input instanceof ArrayBuffer || ArrayBuffer.isView(input)
      || typeof input === 'function') { return input; }

    const result: object = Array.isArray(input) ? new Array(input.length) : Object.create(Object.getPrototypeOf(input));

    remember(result);

    for (const [key, item] of Object.entries(input)) {
      const child = plan?.kind === 'array'
        ? plan.item
        : plan?.kind === 'tuple'
          ? plan.items[Number(key)] ?? (Number(key) >= plan.items.length ? plan.rest : undefined)
          : plan?.kind === 'object' ? Object.hasOwn(plan.members, key) ? plan.members[key] : plan.index : undefined;

      Object.defineProperty(result, key, { value: convert(item, child), enumerable: true, writable: true, configurable: true });
    }

    return result;
  };

  collect(value, shape);

  return convert(value, shape);
}

/** Visit checked adapter branches without inspecting opaque engine objects. */
function shapeChildren(value: unknown, shape: ApiDataShape, visit: (value: unknown, shape: ApiDataShape | undefined) => void): void {
  if (shape.kind === 'map' && value instanceof Map) {
    for (const [key, item] of value) { visit(key, shape.key); visit(item, shape.value); }
  } else if (shape.kind === 'set' && value instanceof Set) {
    for (const item of value) { visit(item, shape.item); }
  } else if ((shape.kind === 'array' || shape.kind === 'tuple') && Array.isArray(value)) {
    value.forEach((item: unknown, index) => visit(item, shape.kind === 'array' ? shape.item : shape.items[index] ?? (index >= shape.items.length ? shape.rest : undefined)));
  } else if (shape.kind === 'object' && isRecord(value)) {
    for (const [key, item] of Object.entries(value)) { visit(item, Object.hasOwn(shape.members, key) ? shape.members[key] : shape.index); }
  }
}

/** Freeze copied snapshots while treating engine references as opaque live handles. */
export function freezeApiData(value: unknown, shape?: ApiDataShape): unknown {
  const opaque = new WeakSet<object>();
  const seen = new WeakSet<object>();

  const mark = (input: unknown, plan: ApiDataShape): void => {
    if (typeof input !== 'object' || input === null || seen.has(input)) { return; }

    seen.add(input);

    if (plan.kind === 'reference' || plan.kind === 'native-value') { opaque.add(input); } else { shapeChildren(input, plan, (item, child) => { if (child) { mark(item, child); } }); }
  };

  if (shape) { mark(value, shape); }

  return freezeData(value, opaque);
}

function transformArguments(args: unknown[], shape: ApiParametersShape | undefined, direction: 'encode' | 'decode', context?: ApiDataContext): unknown[] {
  if (shape === undefined) { return args; }

  const result = transformData(args, { kind: 'tuple', ...shape }, direction, context);

  if (!Array.isArray(result)) { throw new TypeError('invalid API argument tuple'); }

  return result;
}

export function encodeArguments(args: unknown[], shape?: ApiParametersShape, context?: ApiDataContext): { args: unknown[]; missing: number[] } {
  const values = transformArguments(args, shape, 'encode', context).slice();
  const missing: number[] = [];

  for (let index = 0; index < values.length; index++) {
    if (values[index] === undefined) { values[index] = null; missing.push(index); }
  }

  return { args: values, missing };
}

export function decodeArguments(params: unknown, shape?: ApiParametersShape, context?: ApiDataContext): unknown[] {
  if (!isRecord(params) || !Array.isArray(params.args) || !Array.isArray(params.missing)) { throw new TypeError('invalid addon API arguments'); }

  const args: unknown[] = params.args;
  const missing: unknown[] = params.missing;

  for (const index of missing) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= args.length || (args[index] !== null && args[index] !== undefined)) {
      throw new TypeError('invalid addon API argument position');
    }

    args[index] = undefined;
  }

  return transformArguments(args, shape, 'decode', context);
}
