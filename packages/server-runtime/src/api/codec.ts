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

/** Transform only the branches selected by the checked API signature. */
export function transformData(value: unknown, shape: ApiDataShape | undefined, direction: 'encode' | 'decode', context?: ApiDataContext): unknown {
  if (shape === undefined) { return value; }

  if (shape.kind === 'reference') {
    if ((value === undefined || value === null) && shape.missing !== undefined) { return value; }

    if (context?.references === undefined) { throw new Error('API references require reference adapters'); }

    if (direction === 'encode') { return context.references.encode(value, shape); }

    const entity = context.references.decode(value, shape);

    if (entity !== undefined) { return entity; }

    if (shape.missing !== undefined) { return shape.missing === 'null' ? null : undefined; }

    throw new Error(`API ${shape.reference} reference is unavailable`);
  }

  if (value === undefined || value === null) { return value; }

  if (shape.kind === 'native-value') {
    if (context?.values === undefined) { throw new Error('native API values require value adapters'); }

    return direction === 'encode' ? context.values.encode(value, shape.value) : context.values.decode(value, shape.value);
  }

  if (shape.kind === 'codec') {
    if (direction === 'encode') {
      const encoded = shape.codec.encode(value);

      if (encoded === undefined) { throw new TypeError('a value codec must encode defined JSON data'); }

      // A present value stays distinct from null when the codec itself encodes null.
      return [encoded];
    }

    if (!Array.isArray(value) || value.length !== 1) { throw new TypeError('invalid encoded API value'); }

    return shape.codec.decode(value[0]);
  }

  if (shape.kind === 'callback') {
    const callbacks = context?.callbacks;

    if (callbacks === undefined) { throw new Error('callbacks require an active API call'); }

    if (direction === 'decode') { return callbacks.decode(value, shape); }

    if (typeof value !== 'function') { throw new TypeError('expected an async API callback'); }

    return callbacks.encode((...args: unknown[]): unknown => Reflect.apply(value, undefined, args), shape);
  }

  if (shape.kind === 'array' || shape.kind === 'tuple') {
    if (!Array.isArray(value)) { throw new TypeError('expected an API array'); }

    return value.map((item: unknown, index) => transformData(item,
      shape.kind === 'array' ? shape.item : shape.items[index] ?? (index >= shape.items.length ? shape.rest : undefined), direction, context));
  }

  if (!isRecord(value) || Array.isArray(value)) { throw new TypeError('expected an API data object'); }

  const result = { ...value };

  if (shape.index !== undefined) {
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, { value: transformData(item, Object.hasOwn(shape.members, key) ? shape.members[key] : shape.index, direction, context), enumerable: true, configurable: true, writable: true });
    }
  } else {
    for (const [key, member] of Object.entries(shape.members)) {
      if (Object.hasOwn(value, key)) {
        Object.defineProperty(result, key, { value: transformData(value[key], member, direction, context), enumerable: true, configurable: true, writable: true });
      }
    }
  }

  return result;
}

/** Freeze copied snapshots while treating engine references as opaque live handles. */
export function freezeApiData(value: unknown, shape?: ApiDataShape): unknown {
  if (shape?.kind === 'native-value') { return value; }

  if (shape === undefined || shape.kind === 'codec') { return freezeData(value); }

  if (shape.kind === 'reference' || typeof value !== 'object' || value === null) { return value; }

  if ((shape.kind === 'array' || shape.kind === 'tuple') && Array.isArray(value)) {
    value.forEach((item: unknown, index) => freezeApiData(item, shape.kind === 'array' ? shape.item : shape.items[index] ?? (index >= shape.items.length ? shape.rest : undefined)));
  } else if (shape.kind === 'object' && isRecord(value)) {
    for (const [key, item] of Object.entries(value)) { freezeApiData(item, Object.hasOwn(shape.members, key) ? shape.members[key] : shape.index); }
  }

  return Object.freeze(value);
}

function transformArguments(args: unknown[], shape: ApiParametersShape | undefined, direction: 'encode' | 'decode', context?: ApiDataContext): unknown[] {
  if (shape === undefined) { return args; }

  return args.map((value, index) => transformData(value, shape.items[index] ?? (index >= shape.items.length ? shape.rest : undefined), direction, context));
}

export function encodeArguments(args: unknown[], shape?: ApiParametersShape, context?: ApiDataContext): { args: unknown[]; missing: number[] } {
  const values = transformArguments(args, shape, 'encode', context);
  const missing: number[] = [];

  for (let index = 0; index < values.length; index++) {
    if (values[index] === undefined) { missing.push(index); }
  }

  return { args: values, missing };
}

export function decodeArguments(params: unknown, shape?: ApiParametersShape, context?: ApiDataContext): unknown[] {
  if (!isRecord(params) || !Array.isArray(params.args) || !Array.isArray(params.missing)) { throw new TypeError('invalid addon API arguments'); }

  const args: unknown[] = params.args;
  const missing: unknown[] = params.missing;

  for (const index of missing) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= args.length || args[index] !== null) {
      throw new TypeError('invalid addon API argument position');
    }

    args[index] = undefined;
  }

  return transformArguments(args, shape, 'decode', context);
}
