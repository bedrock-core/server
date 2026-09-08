/**
 * `core.shared` — the replicated mirror every realm holds, as typed trees.
 *
 * The owner declares a flat record in `register({ shared })` and gets its tree back; the registry
 * writes the initial values and announces the key names under `core-shared/shape`. A peer's tree,
 * `core.shared.of<Def>(ns)`, is materialized from that announcement and reads the same mirror.
 *
 * The mirror does exactly one job: the owner sets a value, every realm can read it now, and is
 * told when it changes. It is not storage — nothing here touches the world. A value that must
 * survive a restart lives in a db document, and the owner maps it across in one line:
 *
 * ```ts
 * settings.for(world).subscribe(doc => shared.event.set(doc.event));
 * ```
 *
 * A document's subscriber hears the document load, so that line is correct at boot as well as on
 * every later change.
 *
 * Only the owner writes: sync applies a value for namespace `ns` only when the sender is `ns`, and
 * a peer's tree has no `set` at all. A peer that wants a change asks the owner over rpc.
 */
import type { State, StateChange, Unsubscribe } from '@bedrock-core/sync';
import { RESERVED_STATE_PREFIX } from '../scoped-state';
import {
  isShape,
  materialize,
  type PeerSharedTree,
  type Shape,
  type SharedBackend,
  type SharedDef,
  type SharedTree,
} from './tree';

/** The mirror key the owner's key names are announced under. */
export const SHARED_SHAPE_KEY = `${RESERVED_STATE_PREFIX}shared/shape`;

export interface SharedRegistryOptions {
  state: State;
  namespace: string;
}

export class SharedRegistry {
  private readonly _state: State;
  private readonly _namespace: string;
  private readonly _peers = new Map<string, { shape: Shape; tree: unknown }>();
  private _own: unknown;

  constructor(options: SharedRegistryOptions) {
    this._state = options.state;
    this._namespace = options.namespace;
  }

  /** This addon's tree, once declared. */
  get own(): SharedTree<SharedDef> | undefined {
    return this._own as SharedTree<SharedDef> | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  /**
   * Declare this addon's shared keys: writes the initial values and announces the key names.
   * Once per addon.
   */
  define<Def extends SharedDef>(def: Def): SharedTree<Def> {
    if (this._own !== undefined) {
      throw new Error('[shared] already declared for this addon');
    }

    const keys = Object.keys(def);

    for (const key of keys) {
      // Framework announcements — the config schema, guides, this very shape — ride the same
      // mirror under `core-` keys, so an addon's own key may not start there.
      if (key.startsWith(RESERVED_STATE_PREFIX)) {
        throw new Error(`[shared] '${key}' is reserved: keys beginning '${RESERVED_STATE_PREFIX}' belong to the framework`);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const tree = materialize(this._ownBackend(), keys, def) as SharedTree<Def>;

    this._own = tree;

    for (const key of keys) {
      this._state.set(this._namespace, key, def[key]);
    }

    this._state.set(this._namespace, SHARED_SHAPE_KEY, keys);

    return tree;
  }

  /**
   * A peer's tree, typed by the declaration the peer exports, or `undefined` until the peer has
   * announced its keys. Read-only: only the owner writes its own namespace.
   */
  of<Def extends SharedDef>(namespace: string): PeerSharedTree<Def> | undefined {
    const announced = this._state.get(namespace, SHARED_SHAPE_KEY);

    if (!isShape(announced)) {
      return undefined;
    }

    const cached = this._peers.get(namespace);

    if (cached !== undefined && cached.shape === announced) {
      return cached.tree as PeerSharedTree<Def>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    }

    const tree = materialize(this._peerBackend(namespace), announced);

    this._peers.set(namespace, { shape: announced, tree });

    return tree as PeerSharedTree<Def>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  private _ownBackend(): SharedBackend {
    const namespace = this._namespace;

    return {
      read: (key): unknown => this._state.get(namespace, key),
      write: (key, value): void => { this._state.set(namespace, key, value); },
      onChange: (key, listener) => this._changesOf(namespace, key, listener),
    };
  }

  /** No `write`: a peer's node refuses at the call, and sync would drop the message anyway. */
  private _peerBackend(namespace: string): SharedBackend {
    return {
      read: (key): unknown => this._state.get(namespace, key),
      onChange: (key, listener) => this._changesOf(namespace, key, listener),
    };
  }

  private _changesOf(namespace: string, key: string, listener: () => void): Unsubscribe {
    return this._state.subscribe((change: StateChange) => {
      if (change.ns === namespace && change.key === key) {
        listener();
      }
    });
  }
}
