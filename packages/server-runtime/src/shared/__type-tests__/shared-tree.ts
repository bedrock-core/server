/**
 * Type-level tests for the shared tree: `tsc` failing IS the failure. Every declared key becomes
 * one node typed by its value, an object included; a peer's tree has the same keys, reads them as
 * possibly-undefined and cannot write any of them; and `register()` hands back what was declared.
 */
import type { PeerSharedTree, SharedTree } from '../tree';
import type { Registered } from '../../runtime';

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

// register() returns the declared trees.
declare const both: Registered<{ server: { taxRate: { type: 'number'; default: 0; min: 0; max: 1; label: 'Tax' } } }, typeof SHARED>;
declare const onlyShared: Registered<undefined, typeof SHARED>;

both.shared.spawnRate.set(1);
both.config.server.taxRate.get();
onlyShared.shared.event.get();
// @ts-expect-error no config was declared
void onlyShared.config;

void rate;
void label;
void tags;
void event;
void peerRate;
void peerEvent;
