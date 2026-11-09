import type { ReadonlyObservable } from '@bedrock-core/observable';

/** Shared lookup, observation and disposal for library-owned registries. */
export abstract class Registry<T, Snapshot = unknown> {
  abstract readonly snapshot: ReadonlyObservable<Snapshot>;
  abstract get(id: string): T | undefined;
  abstract stop(): void;

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }
}
