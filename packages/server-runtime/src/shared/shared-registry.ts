/**
 * `core.shared` — the replicated mirror every realm holds, as typed trees.
 *
 * The owner declares a shape in `register({ shared })` and gets its tree back; the registry writes
 * the initial values, announces the leaf paths under `core-shared/shape`, and keeps `persisted()`
 * leaves on the world. A peer's tree, `core.shared.of<Def>(ns)`, is materialized from that
 * announcement and reads the same mirror; it writes only where the owner said `open()`, and the
 * mirror's owner-only rule (`@bedrock-core/sync`) is what makes that hold everywhere at once.
 *
 * Persisted values are read back one tick after registration — dynamic properties are not readable
 * before the first tick — so the first snapshot a peer receives may lack them by a tick; the
 * write that restores them broadcasts a delta like any other.
 */
import type { State, StateChange, Unsubscribe } from '@bedrock-core/sync';
import { RESERVED_STATE_PREFIX } from '../scoped-state';
import {
  compileShared,
  leavesOfShape,
  materialize,
  shapeOf,
  type LeafSpec,
  type PeerSharedTree,
  type Shape,
  type SharedBackend,
  type SharedDef,
  type SharedTree,
} from './tree';

/** The mirror key the owner's leaf paths are announced under. */
export const SHARED_SHAPE_KEY = `${RESERVED_STATE_PREFIX}shared/shape`;

/** Where a `persisted()` leaf lives on the world. */
export function sharedDpKey(namespace: string, path: string): string {
  return `core-shared:${namespace}:${path}`;
}

/** The world's dynamic properties, as much of them as persistence needs; injected so the registry runs without the engine. */
export interface PersistenceStore {
  read(key: string): string | undefined;
  write(key: string, value: string | undefined): void;
}

export interface SharedRegistryOptions {
  state: State;
  namespace: string;
  store: PersistenceStore;
  /** Run `fn` once the world is readable — `system.run` in the engine. */
  defer(fn: () => void): void;
  log?(message: string): void;
}

function isShape(value: unknown): value is Shape {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SharedRegistry {
  private readonly _state: State;
  private readonly _namespace: string;
  private readonly _store: PersistenceStore;
  private readonly _defer: (fn: () => void) => void;
  private readonly _log: (message: string) => void;
  private readonly _peers = new Map<string, { shape: Shape; tree: unknown }>();
  private _own: unknown;
  private _leaves: readonly LeafSpec[] = [];

  constructor(options: SharedRegistryOptions) {
    this._state = options.state;
    this._namespace = options.namespace;
    this._store = options.store;
    this._defer = options.defer;
    this._log = options.log ?? ((message: string): void => {
      console.warn(message);
    });
  }

  /** This addon's tree, once declared. */
  get own(): SharedTree<SharedDef> | undefined {
    return this._own as SharedTree<SharedDef> | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  /**
   * Declare this addon's shared shape: writes initial values, announces the leaf paths, restores
   * persisted leaves one tick later. Once per addon.
   */
  define<Def extends SharedDef>(def: Def): SharedTree<Def> {
    if (this._own !== undefined) {
      throw new Error('[shared] already declared for this addon');
    }

    const leaves = compileShared(def);
    const backend = this._ownBackend();
    const tree = materialize(backend, leaves, true) as SharedTree<Def>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

    this._leaves = leaves;
    this._own = tree;

    for (const spec of leaves) {
      if (!spec.persisted) {
        this._state.set(this._namespace, spec.path, spec.initial, { open: spec.open });
      }
    }

    this._state.set(this._namespace, SHARED_SHAPE_KEY, shapeOf(leaves));

    if (leaves.some(spec => spec.persisted)) {
      this._defer(() => {
        this._restore();
      });
    }

    return tree;
  }

  /**
   * A peer's tree, typed by the declaration the peer exports, or `undefined` until the peer has
   * announced its shape. Read-only except for leaves the peer opened.
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

    const tree = materialize(this._peerBackend(namespace), leavesOfShape(announced), false);

    this._peers.set(namespace, { shape: announced, tree });

    return tree as PeerSharedTree<Def>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  private _ownBackend(): SharedBackend {
    const namespace = this._namespace;

    return {
      read: (path): unknown => this._state.get(namespace, path),
      write: (path, value, spec): void => {
        this._state.set(namespace, path, value, { open: spec.open });

        if (spec.persisted) {
          this._persist(spec, value);
        }
      },
      onChange: listener => this._changesOf(namespace, listener),
    };
  }

  private _peerBackend(namespace: string): SharedBackend {
    return {
      read: (path): unknown => this._state.get(namespace, path),
      write: (path, value, spec): void => {
        if (!spec.open) {
          throw new Error(`[shared] '${namespace}' did not open '${path}': only its owner may write it`);
        }

        this._state.set(namespace, path, value);
      },
      onChange: listener => this._changesOf(namespace, listener),
    };
  }

  private _changesOf(namespace: string, listener: (path: string, value: unknown) => void): Unsubscribe {
    return this._state.subscribe((change: StateChange) => {
      if (change.ns === namespace && !change.key.startsWith(RESERVED_STATE_PREFIX)) {
        listener(change.key, change.value);
      }
    });
  }

  private _persist(spec: LeafSpec, value: unknown): void {
    const key = sharedDpKey(this._namespace, spec.path);

    try {
      this._store.write(key, value === undefined ? undefined : JSON.stringify(value));
    } catch (error) {
      this._log(`[shared] could not persist '${spec.path}': ${String(error)}`);
    }
  }

  /** Persisted leaves come back from the world, or start at their declared value. */
  private _restore(): void {
    for (const spec of this._leaves) {
      if (!spec.persisted) {
        continue;
      }

      const raw = this._store.read(sharedDpKey(this._namespace, spec.path));
      let value: unknown = spec.initial;

      if (raw !== undefined) {
        try {
          value = JSON.parse(raw);
        } catch (error) {
          this._log(`[shared] '${spec.path}' on the world is not JSON, using the declared value: ${String(error)}`);
        }
      }

      this._state.set(this._namespace, spec.path, value, { open: spec.open });
    }
  }
}
