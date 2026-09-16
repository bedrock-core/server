# 07 — Capabilities — *Proposed*

Two addons that both ship an energy library must run **one** grid, not two. Bedrock has no shared
module system, so every addon bundles its own copy of every library: the code is duplicated by
construction and only the world state can be shared. A capability is that shared thing named — a
contract several addons implement, with exactly one of them running it and the rest talking to it
through the same local API.

Not started. What is below is the shape and the questions that have to be measured before any of
it is written. How a capability plugs into `register()` — the declaration contract, the election
helper, the owner-namespace state — is the workspace root `PLAN.md` §2.4.

## The concern it names

`core.slot()` answers *what can this runtime do* — the config registry, translations, guides. That
is per runtime, and most extensions stop there. A capability answers a different question: *who
runs the world's energy grid*. It survives the addon that started it being removed, it must not
run twice, and every addon that ships the library has to see the same state through its own copy
of the code.

The pieces already exist and are wired to one hard-coded job. `HostElection` picks a realm by a
pure function of the registry — highest runtime version, ties broken by lowest namespace, no
negotiation messages, re-run whenever a peer appears or disappears. It elects once, globally, for
"who draws the UI". Generalising that election per capability is most of this page.

## Local first, shared only where it must be

Most extensions are **local** and stay local. An addon's config is its own — the registry, the
values and the screens belong to it, nothing is elected, and no other realm ever draws its
settings. Pressing another addon in the list hands the player to THAT addon's list page, a
sibling screen in its own pack, and everything from there — its config, its guide — is served by
the addon that owns it. What crosses a realm is navigation, not settings: the screen references
an addon publishes so a key resolves, and values a peer asks for by rpc.

A capability is the exception, for state no addon can own alone: an energy grid, a fluid network,
a physics world, heat. Election is reserved for those. The test is not "is it shared code" but
*would two of these running at once be wrong*.

## The shape

A capability is a field of the one `register()` call, like config or guides. The library exports
a declaration factory built over the floor's `capability(spec)`, itself a `Declaration`:

```ts
// the addon
const { energy } = core.register({ manifest, energy: registerEnergy({ implementation: '1.4.0' }) });

energy.grid.at(pos).charge;   // read — from the mirror, local, no round trip
await energy.connect(a, b);   // topology — may cross a realm boundary
energy.flow(pos, 40);         // per-tick — never crosses one

// @bedrock-core/energy
export const registerEnergy = (options: { implementation: string }) => capability({
  id: 'core:energy',                        // namespaced like feeds, slots and rpc methods
  contract: 2,                              // MAJOR — a different major is a different capability
  implementation: options.implementation,   // MINOR — decides which compatible copy runs
  state: energyState,                       // the shared tree the owner writes, everyone mirrors
  tick: grid => grid.step(),                // runs in the owner only
  failover: 'adopt',                        // see below — each capability declares its own
});
```

The call site is identical in every addon whether or not this realm won the election.

### Rules

1. **Major is identity.** `core:energy@1` and `core:energy@2` are different capabilities, elected
   separately. Incompatible majors coexist instead of corrupting one another.
2. **Minor decides the winner.** Among compatible copies the newest implementation runs, by the
   rule `HostElection` already applies.
3. **Reads are local, writes are owned.** The owner writes the capability's shared tree; every
   realm mirrors it. A read is a mirror lookup and costs nothing.
4. **Fast path never crosses a realm.** Energy *flow* runs every tick and is computed by the owner
   inside its own tick; *connecting* a machine to the grid is a topology change and may take a
   round trip. A capability that cannot express that split is not ready to be one.
5. **One capability, one owner — not one owner for everything.** Election is per capability, so
   energy and physics can be owned by different addons, which is also how the load spreads.

## Failover is the capability's own problem

An owner can disappear at any time — its addon is removed, its realm unloads. What happens next is
not something the floor can decide for a grid it knows nothing about, so each capability declares
it:

- **`adopt`** — the state is durable and the new owner continues from it. Needs a fence (below).
- **`rebuild`** — the state is derivable from the world (blocks, entities) and the new owner
  recomputes it. Slower, needs no durability.
- **`drop`** — the capability simply stops until an owner returns. Correct for anything cosmetic.

Whatever the policy, a **fence** is required: a generation counter bumped at every election, with
writes carrying the generation they were made under. A write from a deposed owner arriving late is
rejected rather than applied. Without it, failover silently corrupts the state it was meant to
save.

Proposed 2026-09-14 (`PLAN.md` §2.4): the state lives under `core-capability/<id>/…` in the
OWNER's own namespace, and the election names which namespace every realm reads. Sync applies a
namespace's writes only from the node whose id it is, so a deposed owner's late write lands where
nobody reads — the fence falls out of ownership, with no counter and no change to
`ownedNamespaces`. `adopt` then means: copy the previous owner's last mirrored keys into your own
namespace, and continue.

## What changes in what is built

| Today | After |
| --- | --- |
| `HostElection`, one global election, used only for the UI | `elect(capability)`, one election per capability id |
| `core.host.isHost` / `hostId` in the config app | nothing elects — a screen is drawn by the addon whose pack holds it, and navigation moves the player there |
| `ownedNamespaces: [namespace]`, fixed at register | unchanged under the owner-namespace proposal; otherwise a capability namespace whose owner changes on failover |
| config reachable as a runtime property | a local plugin found through its slot, serving its own addon only |

Phase D of the workspace plan removes election from the UI, and it is right to: a compiled screen's
layout lives in its owner's resource pack, so drawing must happen where the pack is. That is a
statement about screens, not about election. The mechanism stays, with no user — **dormant until
the first capability needs it** — rather than being deleted and rebuilt from memory later.

## Startup churn

Addons load at different times, and the election is a pure function of the registry: every peer
that appears re-runs it. A world with ten addons can therefore hand one capability's ownership
over several times in the first few seconds, each time a newer implementation shows up.

That is correct behaviour and it is also when handover is cheapest — early owners hold little or
no state. It still constrains the design in two ways:

1. **A handover must be safe to repeat.** Whatever `failover` does, it happens N times at startup,
   not once. `rebuild` that walks the world is wrong if it runs ten times; `adopt` must be
   idempotent.
2. **Expensive work waits for quiet.** A capability should not start ticking or building state on
   the frame it wins — it should settle first, by a window of no registry change. How long that
   window is, and whether it is a count of ticks or a signal from the registry, is unmeasured.

The alternative — sticky ownership, where the first owner keeps it — is rejected: it makes which
implementation runs depend on load order, so the same world behaves differently between sessions.

## What has to be measured first

Four spikes, each settling one thing this page assumes. Under the owner-namespace proposal, 1 is
not needed and 3 reduces to proving that `State.droppedForeign` counts a non-owner's delta; 2
becomes per-key delta volume at 20 t/s; 4 is unchanged.

1. **Can a namespace's owner change at runtime?** `ownedNamespaces` is fixed when the node starts,
   and sync's late-join snapshot exchange answers for owned namespaces only. Hand a namespace from
   one realm to another and see whether every peer agrees afterwards.
2. **What does a crossing write cost at tick rate?** Measure an rpc round trip per mutation against
   a batched one, at 20 t/s, with the grid sizes a real addon has. This is what decides whether
   rule 4 is a guideline or a hard boundary.
3. **Is a fenced write actually rejected?** Force a failover with a slow write in flight and prove
   the old generation is refused.
4. **How long is startup churn?** Count the ownership handovers a capability sees in a world of
   ten addons, and how long after the last one the registry goes quiet. That number is the settle
   window.

Until 1 and 3 have numbers, `failover: 'adopt'` is a hypothesis.

## Open questions

- **Data skew.** Election picks the newest writer, so an older reader must tolerate a tree written
  by a newer minor. That is an encoding rule — decided once, enforced by the library, not the floor.
- **Load distribution.** Per-capability election spreads owners across addons, but nothing balances
  them deliberately. Whether that needs to be more than incidental is unknown until something owns
  two expensive capabilities at once.
- **Discovery for a capability nobody implements.** An addon that needs energy and finds no
  implementation should degrade, not throw. `registry.onDependenciesSatisfied` and
  `features.add({ condition })` already express exactly this and should be the answer rather than a
  new one.
