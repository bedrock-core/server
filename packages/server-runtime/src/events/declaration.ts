/**
 * `registerEvents(tree)` — the events declaration an addon passes to `register()`.
 *
 * ```ts
 * const { events } = core.register({ manifest, events: registerEvents({ restocked: event<{ item: string }>() }) });
 *
 * events.restocked.emit({ item: 'diamond' });
 * core.events.of<typeof peerTree>('os_shop').sale.subscribe(listener);
 * ```
 *
 * Installing defines the tree on `core.events` — the view over the runtime's node events, which a
 * peer's listener materializes with or without this declaration — and returns its typed tree.
 */
import type { Declaration } from '../declaration';
import type { EventsDef, EventsTree } from './tree';

/** Declare what this addon announces to every realm: `{ purchase: event<{ playerId: string }>() }`. */
export function registerEvents<Def extends EventsDef>(tree: Def): Declaration<EventsTree<Def>> {
  return { install: core => core.events.define(tree) };
}
