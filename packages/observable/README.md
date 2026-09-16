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

`@minecraft/server-ui` is an optional peer dependency, needed only by the `/minecraft` entry.

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

## Documentation

https://bedrock-core.drav.dev/docs/observable

## License

MIT
