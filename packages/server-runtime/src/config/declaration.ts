/**
 * `config(definition)` — the config declaration an addon passes to `register()`.
 *
 * ```ts
 * const declared = core.register({ manifest, config: config(definition) });
 *
 * declared.config.server.taxRate.get();   // typed by the definition
 * core.config.of<ShopConfigDef>('vendor_shop');
 * ```
 *
 * Installing builds the {@link ConfigRegistry} on the runtime's node, namespace and db, parks it
 * as `core.config`, and returns the typed scope accessors. Stopping releases its subscriptions.
 */
import type { Declaration } from '../declaration';
import type { Runtime } from '../runtime';
import { ConfigRegistry, type Config } from './config-registry';
import type { ConfigDefinition } from './schema';

/** What `config(definition)` hands `register()`: the installer, and the definition it was given. */
export interface ConfigDeclaration<I extends ConfigDefinition> extends Declaration<Config<I>> {
  /**
   * The definition as written. An addon's BUILD reads it here — the config screens a section gets
   * are shaped from the same declaration the runtime installs, so the schema is stated once.
   */
  readonly definition: I;
}

/** Declare this addon's config: the scopes, their entries, and the schema version. */
export function config<I extends ConfigDefinition>(definition: I): ConfigDeclaration<I> {
  let registry: ConfigRegistry | undefined;

  return {
    definition,
    install(core: Runtime): Config<I> {
      registry = new ConfigRegistry(core.node, core.namespace, core.db);
      core.provide('config', registry);

      return registry.define(definition);
    },
    stop(): void {
      registry?.stop();
      registry = undefined;
    },
  };
}
