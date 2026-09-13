/**
 * `shared(keys)` — the shared-mirror declaration an addon passes to `register()`.
 *
 * ```ts
 * const declared = core.register({ manifest, shared: shared({ price: 10 }) });
 *
 * declared.shared.price.set(12);          // every realm reads it this tick
 * core.shared.of<typeof peerKeys>('os_shop');
 * ```
 *
 * Installing defines the keys on `core.shared` — the view over the runtime's node state, which a
 * peer read materializes with or without this declaration — and returns their typed tree.
 */
import type { Declaration } from '../declaration';
import type { SharedDef, SharedTree } from './tree';

/** Declare this addon's shared keys: a flat record every realm mirrors and only this addon writes. */
export function shared<Def extends SharedDef>(keys: Def): Declaration<SharedTree<Def>> {
  return { install: core => core.shared.define(keys) };
}
