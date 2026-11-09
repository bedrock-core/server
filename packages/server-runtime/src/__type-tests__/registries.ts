import { defineRegistry, registryReference, type RegistryDefinition, type RegistryAccessor } from '../library';
import type { Runtime, AddonRegistry } from '../index';
// @ts-expect-error Storage is imported from its owning package.
import type { Db as _Db } from '../index';
// @ts-expect-error Storage helpers are imported from their owning package.
import { schema as _schema } from '../index';

interface Texture {
  path: string;
}

const textures: RegistryDefinition<Texture> = {
  id: 'types:textures', contract: 1,
  accepts: (value): value is Texture => typeof value === 'object' && value !== null
    && 'path' in value && typeof value.path === 'string',
};

export function registryTypes(core: Runtime): void {
  const addons: AddonRegistry = core.registry;

  void addons;
  // @ts-expect-error Databases are owned by the library or addon that uses them.
  void core.db;
  const result = core.register({
    manifest: core.manifest,
    textures: defineRegistry(textures, { revision: 2, entries: { 'minecraft:stone': { path: 'textures/stone' } } }),
  });
  const sameRuntime: Runtime = result;
  const publication: RegistryAccessor<Texture> = result.textures;

  void sameRuntime;
  // @ts-expect-error The original import retains its base type.
  void core.textures;
  // @ts-expect-error Installed registry properties are read-only.
  result.textures = publication;
  // @ts-expect-error Runtime methods cannot be replaced by declaration keys.
  core.register({ manifest: core.manifest, stop: defineRegistry(textures, { revision: 1 }) });
  const path: string | undefined = publication.get('minecraft:stone')?.path;

  void path;
  const consumer = core.install(defineRegistry(textures));
  const reference = registryReference(textures, 'minecraft:stone');
  const resolution = consumer.resolve(reference);

  if (resolution.status === 'ready') {
    const texture: string = resolution.entry.value.path;

    void texture;
  }

  const models: RegistryDefinition<{ model: number }> = {
    id: 'types:models', contract: 1,
    accepts: (value): value is { model: number } => typeof value === 'object' && value !== null && 'model' in value && typeof value.model === 'number',
  };

  // @ts-expect-error References keep the target registry's record type.
  consumer.resolve(registryReference(models, 'minecraft:stone'));
  // @ts-expect-error Records must match the owning library's registry contract.
  publication.set('minecraft:dirt', { path: 42 });
  // @ts-expect-error Initial records cannot widen the registry's record type.
  defineRegistry(textures, { revision: 2, entries: { bad: { path: 42 } } });
  // @ts-expect-error Publication snapshots cannot be replaced by consumers.
  publication.snapshot.set({ version: 2, entries: {} });
  // @ts-expect-error Internal registry storage is not a Core application directory.
  void core.registries;
}
