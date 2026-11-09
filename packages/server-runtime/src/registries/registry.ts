import type { Replication, SyncNode } from '@bedrock-core/sync';
import type { AddonRegistry } from './addons';
import { readRegistryDescriptor, type RegistryDescriptor } from './descriptor';
import { RegistryStore, type RegistryDefinition, type RegistryPublication, type RegistryPublicationOptions } from './store';
import { InstallationScope } from '../installation';
import { startTranslationPublishing } from '../i18n/publish';

/** @internal Owns local publications and compact discovery metadata. */
export class Registries {
  private readonly _publications = new Map<string, RegistryPublication<unknown>>();
  private readonly _views = new Set<{ stop(): void }>();
  private readonly _lifetime = new InstallationScope();
  private _started = false;
  private _stopped = false;
  readonly replication: Replication;
  constructor(private readonly _node: SyncNode, readonly directory: AddonRegistry, private readonly _changed: () => void) {
    this.replication = _node.replication;
  }

  start(): void {
    if (this._stopped || this._started) { return; }

    this._started = true;
    this._lifetime.defer(startTranslationPublishing(this, this._node.id));
  }

  descriptors(): readonly RegistryDescriptor[] {
    return Object.freeze([...this._publications.values()].map(publication => publication.descriptor)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  publish<T>(definition: RegistryDefinition<T>, options: RegistryPublicationOptions<NoInfer<T>>): RegistryPublication<T> {
    if (this._stopped) { throw new Error('runtime registries are stopped'); }

    const descriptor = readRegistryDescriptor({ id: definition.id, contract: definition.contract,
      revision: options.revision, minecraft: options.minecraft });

    if (descriptor === undefined || typeof definition.accepts !== 'function') { throw new TypeError('invalid registry publication descriptor'); }

    if (this._publications.has(descriptor.id)) { throw new Error(`registry '${descriptor.id}' is already published`); }

    const lifetime = new InstallationScope();
    const publication = new RegistryStore(descriptor, definition, options.entries ?? {}, () => {
      if (this._publications.get(descriptor.id) !== publication) { return; }

      this._publications.delete(descriptor.id);
      lifetime.stop();
    });

    lifetime.defer(this._changed);
    this._publications.set(descriptor.id, publication);

    try {
      const wire = this.replication.publish(`registry/${descriptor.id}`, { descriptor, snapshot: publication.snapshot.get() });

      lifetime.defer(() => wire.stop());
      lifetime.defer(publication.snapshot.subscribe((snapshot) => { wire.set({ descriptor, snapshot }); }));
      this._changed();
    } catch (error) {
      try { publication.stop(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'registry publication and cleanup failed', { cause: cleanupError });
      }

      throw error;
    }

    return publication;
  }

  /** Local publications are owned by their installation or by the built-in publisher. */
  publication(id: string): RegistryPublication<unknown> | undefined {
    return this._publications.get(id);
  }

  /** Track an optional reader without importing its implementation into Core. */
  track(reader: { stop(): void }): void {
    if (this._stopped) { throw new Error('runtime registries are stopped'); }

    this._views.add(reader);
  }

  release(reader: { stop(): void }): void {
    this._views.delete(reader);
  }

  stop(): void {
    if (this._stopped) { return; }

    this._stopped = true;
    const failures: unknown[] = [];

    try { this._lifetime.stop(); } catch (error) { failures.push(error); }

    for (const view of [...this._views]) {
      try { view.stop(); } catch (error) { failures.push(error); }
    }

    for (const publication of [...this._publications.values()]) {
      try { publication.stop(); } catch (error) { failures.push(error); }
    }

    if (failures.length > 0) { throw new AggregateError(failures, 'registry cleanup failed'); }
  }
}
