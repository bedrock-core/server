/**
 * `@bedrock-core/observable` — the reactive primitive the framework notifies through.
 *
 * Three verbs, `get` / `set` / `subscribe`, the same three a config leaf has and the same three
 * Minecraft's data-driven UI observables have. Pure TypeScript: nothing here imports the engine,
 * so it runs in vitest as it runs in a realm. The bridge to native UI observables lives in the
 * `./minecraft` entry, which is the only file that imports `@minecraft/server-ui`.
 *
 * ```ts
 * import { observable, computed, effect, batch } from '@bedrock-core/observable';
 *
 * const phase = observable<'lobby' | 'fight' | 'end'>('lobby');
 * const alive = observable(new Set<string>());
 * const aliveCount = computed(() => alive.get().size, [alive]);
 *
 * effect(() => bossBar.setTitle(phase.get()), [phase]);
 * aliveCount.subscribe(n => scoreboard.set(n));
 *
 * batch(() => {            // one notification per observable, not one per set
 *   phase.set('end');
 *   alive.set(new Set());
 * });
 * ```
 */
export { observable } from './observable';
export type {
  Equals,
  Listener,
  Observable,
  ObservableOptions,
  ReadonlyObservable,
  Unsubscribe,
} from './observable';

export { computed, effect } from './computed';
export type { Computed } from './computed';

export { batch } from './batch';

export { last } from './last';
export type { Last, Signal } from './last';
