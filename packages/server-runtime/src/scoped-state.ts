import type { State, StateChangeListener, StateKey, Unsubscribe } from '@bedrock-core/sync';

/**
 * A thin wrapper around {@link State} that pre-fills the namespace with the addon's own id,
 * so callers don't have to repeat it on every call. The raw `State` is still accessible via
 * `core.node.state` for reading other addons' namespaces.
 */
export class ScopedState {
  private readonly _state: State;
  private readonly _ns: string;

  constructor(state: State, ns: string) {
    this._state = state;
    this._ns = ns;
  }

  set<T = unknown>(key: StateKey<T>, value: NoInfer<T>): void;
  set(key: string, value: unknown): void {
    this._state.set(this._ns, key, value);
  }

  get<T = unknown>(key: StateKey<T>): NoInfer<T> | undefined;
  get(key: string): unknown | undefined {
    return this._state.get(this._ns, key);
  }

  delete(key: string): void {
    this._state.delete(this._ns, key);
  }

  getNamespace(): Record<string, unknown> {
    return this._state.getNamespace(this._ns);
  }

  /** All namespaces currently present in the mirror (own + peers). */
  namespaces(): string[] {
    return this._state.namespaces();
  }

  /** Notified on every applied change (local or remote). Returns an unsubscribe function. */
  onChange(listener: StateChangeListener): Unsubscribe {
    return this._state.onChange(listener);
  }
}
