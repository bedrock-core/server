/**
 * Type-level tests for the shared tree: `tsc` failing IS the failure. Every declared key becomes
 * one node typed by its value, an object included; a peer's tree has the same keys, reads them as
 * possibly-undefined and cannot write any of them; and `register()` hands back what was declared.
 */
import type { PeerSharedTree, SharedTree } from '../tree';
import type { AddonManifest } from '../../manifest';
import type { Runtime } from '../../runtime';
import { event as declaredEvent, events } from '../../events';
import { shared } from '../declaration';

export const SHARED = {
  spawnRate: 5,
  name: 'lobby',
  tags: ['a', 'b'],
  event: { name: 'none', active: false, votes: 0 },
};

declare const own: SharedTree<typeof SHARED>;
declare const peer: PeerSharedTree<typeof SHARED>;

// Every key carries its declared type, an object as one value.
const rate: number = own.spawnRate.get();
const label: string = own.name.get();
const tags: string[] = own.tags.get();
const event: { name: string; active: boolean; votes: number } = own.event.get();

own.spawnRate.set(6);
own.event.set({ name: 'race', active: true, votes: 0 });

// @ts-expect-error a node takes its own type
own.spawnRate.set('fast');
// @ts-expect-error an object is one value, not a branch of nodes
void own.event.active;
// @ts-expect-error there is no partial write; a whole value replaces it
own.event.set({ active: true });

// Every node is an observable: the listener takes the new value and the one before it.
own.spawnRate.subscribe((next: number, prev: number) => next + prev);
own.event.subscribe((next: { active: boolean }) => next);

// A peer reads the same keys, and may read nothing yet.
const peerRate: number | undefined = peer.spawnRate.get();
const peerEvent: { name: string; active: boolean; votes: number } | undefined = peer.event.get();

peer.spawnRate.subscribe((next: number | undefined) => next);

// @ts-expect-error a peer's tree never writes: it asks the owner over rpc instead
peer.spawnRate.set(1);

// register() returns the declared trees, each under the key it was declared as. Never called: the
// body is the test.
declare const MANIFEST: AddonManifest;

export function declaresTrees(core: Runtime): void {
  const both = core.register({
    manifest: MANIFEST,
    shared: shared(SHARED),
    events: events({ restocked: declaredEvent<{ item: string }>() }),
  });
  const onlyShared = core.register({ manifest: MANIFEST, shared: shared(SHARED) });

  both.shared.spawnRate.set(1);
  both.events.restocked.emit({ item: 'diamond' });
  onlyShared.shared.event.get();
  // @ts-expect-error no events were declared
  void onlyShared.events;
}

void rate;
void label;
void tags;
void event;
void peerRate;
void peerEvent;
