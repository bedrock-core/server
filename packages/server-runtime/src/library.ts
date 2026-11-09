import type { Runtime } from './runtime';

/** One installed library instance and its optional teardown. */
export interface Installation<T> {
  readonly value: T;
  readonly stop?: () => void;
}

/** Cleanup registered during setup also runs when that setup fails. */
export interface InstallationLifetime {
  defer(stop: () => void): void;
}

/** A reusable library recipe. Each installation owns its accessor and cleanup. */
export interface Declaration<T> {
  install(core: Runtime, lifetime: InstallationLifetime): Installation<T>;
}

export { registerModule, type ModuleDeclaration } from './api/declaration';
export { Registry } from './registries/base';
export type { RegistryDescriptor, RegistryMinecraftCoverage } from './registries/descriptor';
export { defineRegistry } from './registries/registration';
export type { RegistryAccessor, RegistryOptions } from './registries/registration';
export type { RegistryDefinition, RegistryEntries } from './registries/store';
export { isRegistryReference, registryReference } from './registries/view';
export type { RegistryEntry, RegistryProvider, RegistryReference, RegistryResolution, RegistrySnapshot, RegistryStatus } from './registries/view';
