# 01 — Observable

`@bedrock-core/observable` — the reactive primitive everything else notifies through. Pure
TypeScript, no Minecraft import, unit-tested in vitest. Three verbs — `get` / `set` / `subscribe` —
the same three a config leaf already has and the same three Mojang's DDUI observables have, so
there is one shape to learn and one adapter to the engine.

## What it is for

In Bedrock there is no client script: a screen is a server-rendered form in the same realm as the
game logic. "UI state vs server state" is not a split that exists here. There is one reactive
primitive; the fiber hook in ui-runtime and the DDUI bridge are two adapters onto it.

An addon reaches for it when several systems watch one value it owns:

```ts
import { observable, computed, effect, batch } from '@bedrock-core/observable';

const phase = observable<'lobby' | 'fight' | 'end'>('lobby');
const alive = observable(new Set<string>());
const aliveCount = computed(() => alive.get().size, [alive]);

effect(() => bossBar.setTitle(phase.get()), [phase]);        // a boss bar
aliveCount.subscribe(n => scoreboard.set(n));                 // a scoreboard
// ...and a screen: useObservable(phase)

batch(() => {                                                 // one notification, not two
  phase.set('end');
  alive.set(new Set());
});
```

Today that is a hand-rolled emitter or a `runInterval` poll. Inside the framework the same thing
already exists three times under other names: config's `ChangeEmitter`, a db document's in-memory
value, a query's result. All three become observables.

## API — *Decided*

```ts
observable<T>(initial: T, options?: { equals?: (a: T, b: T) => boolean }): Observable<T>

interface ReadonlyObservable<T> {
  get(): T;                                                   // current value, sync
  subscribe(listener: (next: T, prev: T) => void): Unsubscribe;
}
interface Observable<T> extends ReadonlyObservable<T> {
  set(next: T | ((prev: T) => T)): void;                      // notifies unless equals(prev, next)
}

computed<T>(compute: () => T, deps: readonly ReadonlyObservable<unknown>[], options?): ReadonlyObservable<T>
effect(run: () => void, deps: readonly ReadonlyObservable<unknown>[]): Unsubscribe
batch(fn: () => void): void
```

- **Immutable values, `Object.is` by default.** `set` replaces; it never mutates in place. An
  observable of an object gets a new object. That is what makes `equals` cheap and `computed` correct.
- **Explicit `deps`, no proxy tracking.** A `Proxy` trap on every property read of every tick is the
  cost the config accessor tree already refused to pay; the same reasoning holds here. Dependencies
  are listed once, at creation.
- **`ReadonlyObservable<T>`** is what `computed` returns and what anything exposing a value it owns
  hands out — a db document, a query, a peer's shared key — so a consumer cannot `set` what is not
  theirs.

## Scheduling — the Minecraft part

- **Notifications are synchronous.** A listener runs inside the `set` that changed the value, in
  the same tick. No microtask hop: a `before` event handler that flips a value must see its
  listeners run before the event resolves, and a tick-driven screen must observe the value the tick
  produced, not the next one.
- **`batch` defers to its end**, then notifies each observable once with its final value. Nested
  batches flush at the outermost. A `computed` inside a batch recomputes once.
- **A throwing listener is isolated**: caught, logged with the observable's label, the remaining
  listeners still run. One addon's bug does not silence another's subscription
  ([07-trust-model §2](./07-trust-model.md#2-robustness-against-a-buggy-pack--the-real-threat)).
- **No async values.** Something that arrives later is a *query* ([04-query](./04-query.md)) — the
  primitive stays synchronous.

## The ui-runtime adapter

```ts
const phase = useObservable(phaseObs);                        // re-renders when it changes
const count = useObservable(playersObs, p => p.size);         // re-renders only when the slice changes
```

`useObservable(obs, selector?)` subscribes in an effect, compares the selected slice with
`Object.is`, and schedules a re-render only on change. It is the one hook that reads an addon's
own observable, a config leaf (`useObservable(config.server.taxRate)`), a db document
(`useObservable(collection.for(player))`) and a query (`useObservable(q)`) alike, because all of
them *are* observables. `useState` / `useReducer` stay component-local as they are.

## Native observables — the DDUI bridge

Mojang's data-driven forms (`@minecraft/server-ui` 2.1.0, stable since 1.26.30) redraw only for
their own observables: `ObservableString`, `ObservableNumber`, `ObservableBoolean`,
`ObservableUIRawMessage`, each with `getData()` / `setData()` / `subscribe()` / `unsubscribe()`, an
optional `{ clientWritable: true }` that lets the player's control write the value, and
`getFilteredText()` on strings. Measured ([S5](./spikes/S5-abi-survey.md)): notification is
synchronous, an equal-value `setData` does not notify, `subscribe` returns the callback (not a
handle — `unsubscribe(cb)` is the release), and a `setData` costs 1 µs. Same verbs, different job:

| | Native `Observable*` | `@bedrock-core/observable` |
| --- | --- | --- |
| Types | four scalars | any `T` — a document, a query result |
| Reason to exist | keep one scalar in sync with an open form | hold a value several systems watch |
| Lifetime | the form's | the data's |
| Composition | none — hand-wire `a.subscribe(v => b.setData(v))` | `computed`, `effect`, `batch` |
| Client can write it | yes, `clientWritable` | impossible — no client channel but a form |
| Import cost | `@minecraft/server-ui` | none |
| Instance cost | an engine object with client sync | a plain object |

We cannot make ours *be* theirs (engine classes, one per scalar), so the bridge is **a bound copy
for the form's lifetime**, from the one entry point that imports the UI module:

```ts
import { toNative } from '@bedrock-core/observable/minecraft';

const { native: volume, dispose } = toNative(config.player.for(p).volume, { clientWritable: true });
new CustomForm(p, 'Settings').slider('Volume', volume, 0, 100).show().then(dispose);
```

Contract — *Decided*:

1. **Ours is the source of truth.** Every change of ours is pushed to the native (`setData`).
2. **Native → ours only when `clientWritable`** — that is the player moving the control. Guarded
   with `Object.is` so our own push never echoes back (native skips equal values itself, but the
   guard is what keeps the two subscriptions from chasing each other).
3. **`dispose()` on form close** — it calls `native.unsubscribe(cb)` with the exact callback it
   registered, the only thing that releases a native listener. A stale form can never write back.
   Our future DDUI host calls it; a user on a raw `CustomForm` calls it in `.show().then()`.
4. **Types are what native can hold**: `number | string | boolean`. An enum leaf binds as a string;
   `list` / `multiselect` have no native control and are refused at the type level.
5. **One native per widget, one of ours per value.** The bridge mints engine objects only for
   controls actually on screen.

The same adapter serves both audiences — people who skip our UI and bind config, db or query values
to their own `CustomForm`, and our host later — so there is exactly one mechanism.

**Measured in S5** — equal-value `setData` does not notify; `subscribe` returns the callback and
`unsubscribe(cb)` is the release; 1 µs per `setData`. One native per visible control is free.

## Non-goals

- Persistence, replication, cross-realm anything. Those are [03-db](./03-db.md),
  [02-shared](./02-shared.md), [04-query](./04-query.md); the observable is what they notify through.
- Dependency auto-tracking. Listed deps, always.
- Replacing native observables inside a `CustomForm`. The engine contract is theirs; we bind to it.
