/**
 * Type-level tests for the shared tree: `tsc` failing IS the failure. Values become leaves,
 * objects become branches, markers keep their flags in the type, a peer's tree is read-only except
 * on opened leaves, and `register()` hands back what was declared.
 */
import type { PeerSharedTree, SharedTree } from '../tree';
import { leaf, open, persisted } from '../markers';
import type { Registered } from '../../runtime';

export const SHARED = {
  spawnRate: 5,
  name: 'lobby',
  tags: ['a', 'b'],
  highScore: open(0),
  event: persisted({ name: 'none', active: false, votes: open(0) }),
  blob: leaf({ x: 1, y: 2 }),
};

declare const own: SharedTree<typeof SHARED>;
declare const peer: PeerSharedTree<typeof SHARED>;

// Leaves carry their declared type.
const rate: number = own.spawnRate.get();
const label: string = own.name.get();
const tags: string[] = own.tags.get();
const blob: { x: number; y: number } = own.blob.get();

own.spawnRate.set(6);
own.blob.set({ x: 3, y: 4 });
// @ts-expect-error a leaf takes its own type
own.spawnRate.set('fast');
// @ts-expect-error an object leaf is one value, not a branch
void own.blob.x;

// Branches: nested value, set, patch at any depth, children.
const event: { name: string; active: boolean; votes: number } = own.event.get();
const active: boolean = own.event.active.get();

own.event.set({ name: 'race', active: true, votes: 0 });
own.event.patch({ active: false });
own.patch({ event: { votes: 1 } });
// @ts-expect-error a patch takes the branch's own keys
own.event.patch({ other: 1 });

// Every node subscribes with its value.
own.spawnRate.subscribe((n: number) => n);
own.event.subscribe((e: { active: boolean }) => e);
own.subscribe((all: { spawnRate: number; event: { name: string } }) => all);

// A peer reads everything, maybe undefined, and writes only what the owner opened.
const peerRate: number | undefined = peer.spawnRate.get();
const peerEvent: { name: string | undefined; active: boolean | undefined } = peer.event.get();

peer.highScore.set(10);
peer.event.votes.set(1);
// @ts-expect-error the owner did not open spawnRate
peer.spawnRate.set(1);
// @ts-expect-error a peer branch has no set
peer.event.set({ name: 'x', active: true, votes: 0 });

// register() returns the declared trees.
declare const both: Registered<{ server: { taxRate: { type: 'number'; default: 0; min: 0; max: 1; label: 'Tax' } } }, typeof SHARED>;
declare const onlyShared: Registered<undefined, typeof SHARED>;

both.shared.spawnRate.set(1);
both.config.server.taxRate.get();
onlyShared.shared.event.active.get();
// @ts-expect-error no config was declared
void onlyShared.config;

void rate;
void label;
void tags;
void blob;
void event;
void active;
void peerRate;
void peerEvent;
