# @bedrock-core/observable

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The reactive primitive the bedrock-core stack notifies through: a value with three verbs — `get` /
`set` / `subscribe` — the same three a config leaf has and the same three Minecraft's data-driven
UI observables have, plus `computed`, `effect` and `batch` on top; pure TypeScript with nothing
here importing the engine, so it runs in vitest exactly as it runs in a realm, with the one bridge
to `@minecraft/server-ui` living at the separate `@bedrock-core/observable/minecraft` entry.

## Install

```bash
yarn add @bedrock-core/observable
```

The `/minecraft` entry imports `@minecraft/server` (`>=2.0.0`) and `@minecraft/server-ui`
(`>=2.1.0`). Both are optional peer dependencies when using only the main entry.

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

## Debounce

`debounce(source, schedule, options?)` creates a read-only observable initialized from the source.
Each source notification cancels and replaces the scheduled delivery. After a quiet period, it
publishes the latest value; `get()` retains the last published value while waiting. Equality,
listener isolation and `(next, prev)` follow the same rules as `observable`.

The scheduler owns the delay and returns a cancellation function. For Minecraft tick timing:

```ts
import { debounce, observable } from '@bedrock-core/observable';
import { afterTicks } from '@bedrock-core/observable/minecraft';

const query = observable('');
const settledQuery = debounce(query, afterTicks(5));

settledQuery.subscribe(next => console.warn(next));
query.set('stone');
query.set('stone bricks'); // publishes the latest value after five quiet ticks
```

`afterTicks(ticks)` accepts a non-negative safe integer and returns a reusable scheduler using
[`System.runTimeout` and `System.clearRun`](https://learn.microsoft.com/minecraft/creator/scriptapi/minecraft/server/system).
It is also exported from `@bedrock-core/server/observable`. A zero delay uses Minecraft's
current-tick/as-soon-as-possible scheduling.
The main package entry remains independent of Minecraft. The returned `Debounced<T>` subscribes
eagerly. Call `settledQuery.dispose()` when its owner ends to cancel pending delivery and release
the source subscription; its last published value stays readable.

## Documentation

https://bedrock-core.drav.dev/docs/observable

## License

MIT
