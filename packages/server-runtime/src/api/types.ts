import type { ReadonlyObservable, Signal } from '@bedrock-core/observable';
import type { Block, BlockComponent, BlockPermutation, Container, ContainerSlot, Dimension, Entity, EntityComponent, ItemStack } from '@minecraft/server';

/** A value class's shared, synchronous mapping to and from supported application data. */
export interface Codec<Value, Data> {
  encode(value: Value): Data;
  decode(data: Data): Value;
}

export type NativeReference = 'entity' | 'player' | 'dimension' | 'block' | 'entity-component' | 'block-component' | 'container' | 'container-slot';
export type NativeValue = 'item-stack' | 'block-permutation';

export type ApiReferenceShape = (
  | { readonly reference: NativeReference; readonly nativeType?: string }
  | { readonly reference: 'api'; readonly contract: string; readonly shape: ApiModuleShape }
) & { readonly kind: 'reference'; readonly missing?: 'undefined' | 'null' };

export interface ApiObjectAddress {
  readonly owner: string;
  readonly instance: string;
  readonly id: string;
  readonly contract: string;
}

/** Only fields requiring value reconstruction or call-scoped callbacks are described. */
export type ApiDataShape
  = | { readonly kind: 'codec'; readonly codec: Codec<unknown, unknown> }
    | { readonly kind: 'native-value'; readonly value: NativeValue }
    | ApiReferenceShape
    | ({ readonly kind: 'callback' } & ApiCallShape)
    | { readonly kind: 'map'; readonly key?: ApiDataShape; readonly value?: ApiDataShape }
    | { readonly kind: 'set'; readonly item: ApiDataShape }
    | { readonly kind: 'array'; readonly item: ApiDataShape }
    | { readonly kind: 'tuple'; readonly items: readonly (ApiDataShape | null)[]; readonly rest?: ApiDataShape }
    | { readonly kind: 'object'; readonly members: Readonly<Record<string, ApiDataShape>>; readonly index?: ApiDataShape };

export interface ApiParametersShape {
  readonly items: readonly (ApiDataShape | null)[];
  readonly rest?: ApiDataShape;
}

export interface ApiCallShape {
  readonly parameters?: ApiParametersShape;
  readonly result?: ApiDataShape;
}

/** Immutable constants described by generated API bindings. */
export type ApiConstant = undefined | null | boolean | number | string | readonly ApiConstant[] | { readonly [key: string]: ApiConstant };

/** Builder's checked public export kinds and immutable constants. */
export type ApiShape
  = | ({ readonly kind: 'function' } & ApiCallShape)
    | { readonly kind: 'state' | 'event'; readonly data?: ApiDataShape }
    | { readonly kind: 'local'; readonly value: unknown }
    | { readonly kind: 'value'; readonly value: ApiConstant }
    | ApiModuleShape;

/** A public package entry, or a nested object within it. */
export interface ApiModuleShape {
  readonly kind: 'object';
  readonly members: Readonly<Record<string, ApiShape>>;
}

type ReadonlyValue<T> = T extends Entity | Dimension | Block | EntityComponent | BlockComponent | Container | ContainerSlot | ItemStack | BlockPermutation ? T
  : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<ReadonlyValue<K>, ReadonlyValue<V>>
    : T extends ReadonlySet<infer V> ? ReadonlySet<ReadonlyValue<V>>
      : T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: ReadonlyValue<T[K]> } : T;

/** Imported exports: async calls, snapshots that can be absent, and events without emit. */
export type ApiModule<T> = T extends abstract new (...args: never[]) => unknown ? T : T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<R>
  : T extends (...args: never[]) => unknown
    ? never
    : T extends { get(): infer V; subscribe: unknown }
      ? ReadonlyObservable<ReadonlyValue<V> | undefined>
      : T extends { subscribe(callback: (payload: infer P) => void): unknown }
        ? Signal<ReadonlyValue<P>>
        : T extends readonly unknown[]
          ? ReadonlyValue<T>
          : T extends object
            ? { readonly [K in keyof T]: ApiModule<T[K]> }
            : T;
