# @bedrock-core/observable

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The reactive primitive the bedrock-core stack notifies through. A value with three verbs —
`get` / `set` / `subscribe` — the same three a config leaf has and the same three Minecraft's
data-driven UI observables have, plus `computed`, `effect` and `batch` on top.

Pure TypeScript. Nothing here imports the engine, so it runs in vitest exactly as it runs in a
realm. The one bridge to `@minecraft/server-ui` is a separate entry, `@bedrock-core/observable/minecraft`.

## Install

```bash
yarn add @bedrock-core/observable
```

`@minecraft/server-ui` (`>=2.1.0`) is an optional peer dependency, needed only by the `/minecraft` entry.

## Usage

```ts
import { observable, computed, effect, batch, last } from '@bedrock-core/observable';

const phase = observable<'lobby' | 'fight' | 'end'>('lobby');
const alive = observable(new Set<string>());
const aliveCount = computed(() => alive.get().size, [alive]);

effect(() => bossBar.setTitle(phase.get()), [phase]);   // runs now and on every change
aliveCount.subscribe(n => scoreboard.set(n));            // (next, prev)

batch(() => {                                            // one notification per observable
  phase.set('end');
  alive.set(new Set());
});

const spawn = last(world.afterEvents.playerSpawn);       // undefined, then each payload
const lastName = computed(() => spawn.get()?.player.name, [spawn]);
spawn.dispose();                                          // releases the engine subscription
```

- **Synchronous.** A listener runs inside the `set` that changed the value, in the same tick.
  `batch` is the only thing that defers, and it delivers at its end, in order.
- **Immutable values, `Object.is` by default.** `set` replaces; an observable of an object gets a
  new object. Pass `equals` to change what counts as a change.
- **Listed dependencies.** `computed` and `effect` take their dependencies explicitly — no proxy,
  no tracking, no cost on reads.
- **Isolated listeners.** One that throws is reported (with the observable's `label`) and skipped;
  the rest still run.
- **`ReadonlyObservable<T>`** is what `computed` returns and what anything exposing a value it owns
  hands out, so a consumer cannot `set` what is not theirs.
- **`last(signal)`** turns an event into a value: the most recent payload, `undefined` before the
  first. Any `subscribe` works — the engine's, which returns the callback and releases through
  `unsubscribe(cb)`, and the framework's, which returns a release function. Eager, so nothing is
  missed; `dispose()` ends it. Use it on `afterEvents`, never `beforeEvents`.

## Binding to a data-driven form

```ts
import { toNative } from '@bedrock-core/observable/minecraft';

const { native: volume, dispose } = toNative(settings.volume, { clientWritable: true });

new CustomForm(player, 'Settings')
  .slider('Volume', volume, 0, 100)
  .show()
  .then(dispose);
```

`toNative` mints one native observable per control and keeps it in step with yours for the form's
lifetime: yours is the source of truth, the native writes back only when `clientWritable`, and
`dispose()` releases both directions. Scalars only — `number`, `string`, `boolean`; derive one with
`computed` from anything larger.

## Documentation

- [observable](https://bedrock-core.drav.dev/docs/observable) — `observable`, `computed`, `effect`, `batch`, `last`, `toNative`

## License

MIT
