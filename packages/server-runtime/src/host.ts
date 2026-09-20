/**
 * Host election — which realm should do the work that exactly one realm may do.
 *
 * Some jobs cannot be done by every addon in a world at once. This election picks the realm
 * running the NEWEST `@bedrock-core/server-runtime` ({@link RUNTIME_VERSION}), so a world with
 * an addon built last year and one built today gets today's behaviour for whatever is elected.
 *
 * ```ts
 * if (core.host.isHost) { doTheWork(player); }
 * else { core.rpc.request(core.host.id.get(), 'core:do-the-work', { playerId: player.id }); }
 *
 * core.host.id.subscribe(hostId => console.warn('the host is now', hostId));
 * ```
 *
 * The winner is a pure function of the registry, so it is expressed as one: {@link HostElection.id}
 * is `computed` over `registry.addons` and re-derives itself whenever an addon appears or
 * disappears. Nothing is exchanged to reach it — every realm sees the same registry and applies the
 * same rule (highest runtime version, ties broken by the lowest namespace), so they all
 * independently agree on the same winner without a negotiation message.
 *
 * **Nothing uses it today.** The UI draws a screen in the realm whose pack holds it and asks
 * that realm over RPC, which needs no single winner. It stays because one owner per job is what
 * a capability needs — energy, fluids, physics: a single writer of a shared simulation — and
 * that model is not measured yet. Read it as a mechanism waiting for its first caller, not as a
 * description of how anything currently behaves.
 */
import { computed, type Computed, type ReadonlyObservable } from '@bedrock-core/observable';
import type { Unsubscribe } from '@bedrock-core/sync';
import type { RegisteredAddon, Registry } from './registry';
import { compareVersions } from './version';

/** Notified with the new host's namespace, and the one it replaced. */
export type HostListener = (hostId: string, previousHostId: string) => void;

/**
 * Highest runtime version wins; equal versions are broken by the lowest namespace.
 * The tie-break must be total and stable or two realms could each believe they won.
 */
function elect(addons: readonly RegisteredAddon[], fallbackId: string): string {
  let winner: RegisteredAddon | undefined;

  for (const addon of addons) {
    if (winner === undefined) {
      winner = addon;
      continue;
    }

    const byVersion = compareVersions(addon.runtimeVersion, winner.runtimeVersion);

    if (byVersion > 0 || (byVersion === 0 && addon.id < winner.id)) { winner = addon; }
  }

  return winner?.id ?? fallbackId;
}

/** Which realm does the work only one realm may do: a value derived from the registry. */
export class HostElection {
  /**
   * Transport id of the realm running the newest runtime, as an observable. Falls back to this
   * addon's own id when the registry is somehow empty, so callers always have a target.
   */
  readonly id: ReadonlyObservable<string>;

  private readonly _registry: Registry;
  private readonly _selfId: string;
  private readonly _id: Computed<string>;

  constructor(registry: Registry, selfId: string) {
    this._registry = registry;
    this._selfId = selfId;
    this._id = computed(() => elect(registry.addons.get(), selfId), [registry.addons], { label: 'host' });
    this.id = this._id;
  }

  /** Stop following the registry. The last elected host stays readable. */
  stop(): void {
    this._id.dispose();
  }

  /** Whether this realm is the current host and should do the work itself. */
  get isHost(): boolean {
    return this._id.get() === this._selfId;
  }

  /** The elected host's registry entry, when it is still present. */
  get host(): RegisteredAddon | undefined {
    return this._registry.get(this._id.get());
  }

  /**
   * Notified when hosting moves. Fires only on an actual change; subscribing does not deliver the
   * current host, which {@link HostElection.id} already has. Returns an unsubscribe function.
   */
  subscribe(listener: HostListener): Unsubscribe {
    return this._id.subscribe(listener);
  }
}
