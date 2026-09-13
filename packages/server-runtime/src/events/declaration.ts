/**
 * `events(tree)` — the events declaration an addon passes to `register()`.
 *
 * ```ts
 * const declared = core.register({ manifest, events: events({ restocked: event<{ item: string }>() }) });
 *
 * declared.events.restocked.emit({ item: 'diamond' });
 * core.events.of<typeof peerTree>('os_shop').sale.subscribe(listener);
 * ```
 *
 * Installing defines the tree on `core.events` — the view over the runtime's node events, which a
 * peer's listener materializes with or without this declaration — and returns its typed tree.
 */
import type { Declaration } from '../declaration';
import type { EventsDef, EventsTree } from './tree';

/** Declare what this addon announces to every realm: `{ purchase: event<{ playerId: string }>() }`. */
export function events<Def extends EventsDef>(tree: Def): Declaration<EventsTree<Def>> {
  return { install: core => core.events.define(tree) };
}
