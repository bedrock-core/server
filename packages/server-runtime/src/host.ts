/**
 * Host election — which realm should do the work that exactly one realm may do.
 *
 * Some jobs cannot be done by every addon in a world at once. This election picks the realm
 * running the NEWEST `@bedrock-core/server-runtime` ({@link RUNTIME_VERSION}), so a world with
 * an addon built last year and one built today gets today's behaviour for whatever is elected.
 *
 * ```ts
 * if (core.host.isHost) { doTheWork(player); }
 * else { core.rpc.request(core.host.hostId, 'core:do-the-work', { playerId: player.id }); }
 *
 * core.host.subscribe(hostId => console.warn('the host is now', hostId));
 * ```
 *
 * The result is deterministic and needs no negotiation messages: every realm sees the same
 * registry and applies the same rule — highest runtime version, ties broken by the lowest
 * namespace — so they all independently agree on the same winner. Re-elected whenever a
 * peer appears or disappears.
 *
 * **Nothing uses it today.** The UI draws a screen in the realm whose pack holds it and asks
 * that realm over RPC, which needs no single winner. It stays because one owner per job is what
 * a capability needs — energy, fluids, physics: a single writer of a shared simulation — and
 * that model is not measured yet. Read it as a mechanism waiting for its first caller, not as a
 * description of how anything currently behaves.
 */
import type { Unsubscribe } from '@bedrock-core/sync';
import type { RegisteredAddon, Registry } from './registry';
import { compareVersions } from './version';

/** Notified with the new host's namespace, and the previous one when there was one. */
export type HostListener = (hostId: string, previousHostId: string | undefined) => void;

/** Which realm does the work only one realm may do: a pure function of the registry. */
export class HostElection {
  private readonly _registry: Registry;
  private readonly _selfId: string;
  private readonly _listeners = new Set<HostListener>();
  private readonly _disposers: Unsubscribe[] = [];
  private _hostId: string;

  constructor(registry: Registry, selfId: string) {
    this._registry = registry;
    this._selfId = selfId;
    this._hostId = this.elect();
  }

  /** Re-elect whenever the set of live addons changes. */
  start(): void {
    this._disposers.push(
      this._registry.onRegister(() => this.reelect()),
      this._registry.onUnregister(() => this.reelect()),
    );

    this.reelect();
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    this._listeners.clear();
  }

  /**
   * Transport id of the realm running the newest runtime. Falls back to this addon's own id
   * when the registry is somehow empty, so callers always have a target.
   */
  get hostId(): string {
    return this._hostId;
  }

  /** Whether this realm is the current host and should do the work itself. */
  get isHost(): boolean {
    return this._hostId === this._selfId;
  }

  /** The elected host's registry entry, when it is still present. */
  get host(): RegisteredAddon | undefined {
    return this._registry.get(this._hostId);
  }

  /**
   * Notified when hosting moves — including the initial election, if you subscribe before
   * peers appear. Fires only on an actual change. Returns an unsubscribe function.
   */
  subscribe(listener: HostListener): Unsubscribe {
    this._listeners.add(listener);

    return (): void => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Highest runtime version wins; equal versions are broken by the lowest namespace.
   * The tie-break must be total and stable or two realms could each believe they won.
   */
  private elect(): string {
    let winner: RegisteredAddon | undefined;

    for (const addon of this._registry.all()) {
      if (winner === undefined) {
        winner = addon;
        continue;
      }

      const byVersion = compareVersions(addon.runtimeVersion, winner.runtimeVersion);

      if (byVersion > 0 || (byVersion === 0 && addon.id < winner.id)) { winner = addon; }
    }

    return winner?.id ?? this._selfId;
  }

  private reelect(): void {
    const next = this.elect();

    if (next === this._hostId) { return; }

    const previous = this._hostId;

    this._hostId = next;

    for (const listener of this._listeners) { listener(next, previous); }
  }
}
