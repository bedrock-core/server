import type { Declaration, Installation } from '../library';
import type { Runtime } from '../runtime';
import type { RegistryMinecraftCoverage } from './descriptor';
import { readRegistryDescriptor } from './descriptor';
import { registryOf } from '../installation';
import type { RegistryDefinition, RegistryEntries, RegistryPublication } from './store';
import { RegistryView, type RegistryReader, type RegistryReadOptions } from './view';

/** One installed registry: reads include compatible providers; writes affect this addon only. */
export interface RegistryAccessor<T> extends RegistryReader<T> {
  set(id: string, value: T): void;
  delete(id: string): boolean;
  replace(entries: RegistryEntries<T>): void;
}

export interface RegistryOptions<T> extends RegistryReadOptions<T> {
  /** Revision of this addon's dataset. Defaults to 1 when first published. */
  readonly revision?: number;
  readonly entries?: RegistryEntries<T>;
  /** Minecraft versions covered by this addon's published records. */
  readonly coverage?: RegistryMinecraftCoverage;
}

/** @internal Optional readers are constructed outside Core's publisher module graph. */
export function createRegistryReader<T>(runtime: Runtime, definition: RegistryDefinition<T>, options: RegistryReadOptions<T> = {}, stopped?: () => void): RegistryReader<T> {
  const host = registryOf(runtime);

  if (typeof definition.accepts !== 'function' || readRegistryDescriptor({ id: definition.id, contract: definition.contract, revision: 0,
    ...(options.minecraft === undefined ? {} : { minecraft: { min: options.minecraft } }) }) === undefined
    || (options.contracts !== undefined && (options.contracts.length === 0 || options.contracts.some(value => !Number.isSafeInteger(value) || value < 1)))
    || (options.providers !== undefined && options.providers.some(value => typeof value !== 'string' || value.length === 0))
    || (options.select !== undefined && typeof options.select !== 'function')) { throw new TypeError('invalid registry options'); }

  const copied = Object.freeze({ ...options,
    ...(options.providers === undefined ? {} : { providers: Object.freeze([...options.providers]) }),
    ...(options.contracts === undefined ? {} : { contracts: Object.freeze([...options.contracts]) }),
    ...(options.minecraft === undefined ? {} : { minecraft: Object.freeze([...options.minecraft] as const) }) });
  const reader = new RegistryView(definition, copied, host.directory, host.replication, id => host.publication(id), (value) => {
    host.release(value);
    stopped?.();
  });

  try { host.track(reader); } catch (error) { reader.stop(); throw error; }

  return reader;
}

/** Define a registry installation. Publishing starts with initial records or a write. */
export function defineRegistry<T>(definition: RegistryDefinition<T>, options: RegistryOptions<NoInfer<T>> = {}): Declaration<RegistryAccessor<T>> {
  const contract = Object.freeze({ ...definition });

  return { install(runtime, lifetime): Installation<RegistryAccessor<T>> {
    const host = registryOf(runtime);
    let publication: RegistryPublication<T> | undefined;
    let active = true;

    const requireActive = (): void => {
      if (!active) { throw new Error(`registry '${contract.id}' is stopped`); }
    };

    const stopPublication = (): void => {
      active = false;
      const owned = publication;

      publication = undefined;
      owned?.stop();
    };

    lifetime.defer(stopPublication);

    if (readRegistryDescriptor({ id: contract.id, contract: contract.contract, revision: options.revision ?? 1, minecraft: options.coverage }) === undefined) {
      throw new TypeError('invalid registry publication options');
    }

    const publish = (entries: RegistryEntries<T>): void => {
      requireActive();
      publication = host.publish(contract, { revision: options.revision ?? 1, minecraft: options.coverage, entries });
    };

    if (options.entries !== undefined || options.revision !== undefined) { publish(options.entries ?? {}); }

    const reader = createRegistryReader(runtime, contract, options, stopPublication);

    lifetime.defer(() => reader.stop());
    const value: RegistryAccessor<T> = Object.assign(reader, {
      set(id: string, record: T): void {
        requireActive();

        if (publication) { publication.set(id, record); } else { publish({ [id]: record }); }
      },
      delete(id: string): boolean {
        requireActive();

        return publication?.delete(id) ?? false;
      },
      replace(entries: RegistryEntries<T>): void {
        requireActive();

        if (publication) { publication.replace(entries); } else { publish(entries); }
      },
    });

    return { value };
  } };
}
