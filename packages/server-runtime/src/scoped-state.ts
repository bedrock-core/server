import type { State, StateChangeListener, StateKey, Unsubscribe } from '@bedrock-core/sync';

/**
 * Keys under this prefix belong to the framework, not to the addon.
 *
 * An addon's namespace carries more than the addon put there: the config schema, the by-locale
 * translation keys, the compiled guide and the feature states all replicate under the same
 * namespace (`core-config/`, `core-i18n/`, `core-guide/`, `core-feature/`). Those are large — a compiled
 * guide alone dwarfs a dynamic property's 32 KB limit — so an addon that reasonably treats
 * "my namespace" as "my data" and persists it would blow up on the first write.
 *
 * {@link ScopedState} therefore hides them: it reads, reports and enumerates only what the addon
 * itself wrote, and refuses to let it write into the reserved space. Reach the raw namespace,
 * framework keys included, through `core.node.state`.
 */
export const RESERVED_STATE_PREFIX = 'core-';

/** Whether a state key belongs to the framework rather than to the addon that owns the namespace. */
export function isReservedStateKey(key: string): boolean {
  return key.startsWith(RESERVED_STATE_PREFIX);
}

/**
 * A thin wrapper around {@link State} that pre-fills the namespace with the addon's own id, so
 * callers don't have to repeat it on every call, and that hides the framework's own keys — see
 * {@link RESERVED_STATE_PREFIX}. The raw `State` is still accessible via `core.node.state` for
 * reading other addons' namespaces, or this one's framework keys.
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
    this.requireOwnKey(key, 'set');
    this._state.set(this._ns, key, value);
  }

  get<T = unknown>(key: StateKey<T>): NoInfer<T> | undefined;
  get(key: string): unknown | undefined {
    return isReservedStateKey(key) ? undefined : this._state.get(this._ns, key);
  }

  delete(key: string): void {
    this.requireOwnKey(key, 'delete');
    this._state.delete(this._ns, key);
  }

  /**
   * Everything this addon has written, without the framework's own keys — safe to serialize and
   * persist whole, which is the usual reason to ask for it.
   */
  getNamespace(): Record<string, unknown> {
    const own: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(this._state.getNamespace(this._ns))) {
      if (!isReservedStateKey(key)) { own[key] = value; }
    }

    return own;
  }

  /** All namespaces currently present in the mirror (own + peers). */
  namespaces(): string[] {
    return this._state.namespaces();
  }

  /**
   * Notified when this addon's own state changes, local or remote. Framework keys and other
   * addons' namespaces are filtered out, so a listener that persists {@link getNamespace} does
   * not also fire on every schema, translation and guide broadcast. Use `core.node.state` to
   * observe everything.
   */
  subscribe(listener: StateChangeListener): Unsubscribe {
    return this._state.subscribe((change) => {
      if (change.ns !== this._ns || isReservedStateKey(change.key)) { return; }

      listener(change);
    });
  }

  private requireOwnKey(key: string, operation: string): void {
    if (isReservedStateKey(key)) {
      throw new Error(
        `cannot ${operation} state key '${key}': '${RESERVED_STATE_PREFIX}' is reserved for bedrock-core`,
      );
    }
  }
}
