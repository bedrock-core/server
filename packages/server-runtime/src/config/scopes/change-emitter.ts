import type { Unsubscribe } from '@bedrock-core/sync';

export type ChangeListener<V = unknown> = (next: V, prev: V | undefined) => void;

export class ChangeEmitter {
  private readonly _listeners = new Map<string, Set<ChangeListener>>();

  on(path: string, fn: ChangeListener): Unsubscribe {
    let set = this._listeners.get(path);

    if (!set) { set = new Set(); this._listeners.set(path, set); }

    set.add(fn);

    return () => { this._listeners.get(path)?.delete(fn); };
  }

  emit(path: string, next: unknown, prev: unknown): void {
    this._listeners.get(path)?.forEach(fn => fn(next, prev));
  }

  has(path: string): boolean {
    return (this._listeners.get(path)?.size ?? 0) > 0;
  }

  hasAny(): boolean {
    return this._listeners.size > 0;
  }

  clear(): void {
    this._listeners.clear();
  }
}
