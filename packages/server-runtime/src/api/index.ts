import { defaultBindings, createModule, provideModule } from './bindings';
import type { ApiModule, ApiModuleShape } from './types';

/** @internal Builder consumer binding. No transport or registration is needed while importing. */
export function createApiModule<T>(namespace: string, moduleName: string, shape: ApiModuleShape): ApiModule<T> {
  return createModule<T>(defaultBindings, namespace, moduleName, shape);
}

/** @internal Builder provider binding. Returns an idempotent module withdrawal function. */
export function provideApiModule(moduleName: string, shape: ApiModuleShape, exports: unknown): () => void {
  return provideModule(defaultBindings, moduleName, shape, exports);
}

export { defineApiModule, defineApiDeclaration } from './declaration';
export type { ApiConstant, ApiModule, ApiModuleShape, ApiShape, Codec } from './types';
