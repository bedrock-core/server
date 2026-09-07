/**
 * A host is where a document's bytes sit. The engine offers two ABIs for dynamic properties —
 * six methods on world, entities and container slots; three on a block entity's component — and
 * nothing at all on a dimension or a vanilla block. This file is the one adapter over all of it:
 * three verbs, one capability record, and the target's identity where it has to be part of the key.
 *
 * Every number here is measured, not assumed — see `docs/spikes/S2`, `S4` and `S5`. Hosts are
 * classes with prototype methods rather than closures: the engine's JavaScript is QuickJS, where a
 * host is made per operation and each closure costs.
 */

/** What a dynamic property can hold. Documents travel as JSON strings under the per-value cap. */
export type DpValue = boolean | number | string | { x: number; y: number; z: number };

/** The six-method ABI: `World`, `Entity`, `Player`, `ContainerSlot`. */
export interface DirectDp {
  getDynamicProperty(identifier: string): DpValue | undefined;
  setDynamicProperty(identifier: string, value?: DpValue): void;
  getDynamicPropertyIds(): string[];
  getDynamicPropertyTotalByteCount(): number;
  setDynamicProperties?(values: Record<string, DpValue | undefined>): void;
}

/** The three-method ABI: `BlockDynamicPropertiesComponent`. */
export interface ComponentDp {
  get(key: string): DpValue | undefined;
  set(key: string, value?: DpValue): void;
  totalByteCount(): number;
}

export type HostAbi = 'direct' | 'component' | 'proxied';

export interface Capabilities {
  /** The bytes live on the target and die with it. `false` means a world property keyed by identity. */
  readonly own: boolean;
  /** Keys can be listed, so a collection needs no index of its own. */
  readonly enumerable: boolean;
  /** Characters per value on the direct ABI; bytes per block on the component ABI. */
  readonly budget: number;
  /** Reachable while the target is not loaded. */
  readonly readableWhenUnloaded: boolean;
  /** `setDynamicProperties` is available for a one-call flush. */
  readonly batch: boolean;
}

export interface DpHost {
  readonly abi: HostAbi;
  readonly caps: Capabilities;
  read(key: string): DpValue | undefined;
  write(key: string, value: DpValue | undefined): void;
  /** `undefined` when the ABI cannot list keys. */
  keys(): readonly string[] | undefined;
  bytes(): number;
  writeMany(values: Record<string, DpValue | undefined>): void;
}

/** A dynamic-property string may hold this many characters; one more throws. Measured. */
export const DIRECT_BUDGET = 32_767;

/** A block entity holds this many bytes per pack, key and overhead included; more throws. Measured. */
export const COMPONENT_BUDGET = 950;

const direct = (batch: boolean, readableWhenUnloaded: boolean): Capabilities =>
  Object.freeze({ own: true, enumerable: true, budget: DIRECT_BUDGET, readableWhenUnloaded, batch });

/** The four direct capability records, so a host never allocates one. */
const DIRECT_CAPS = {
  loaded: { batch: direct(true, false), single: direct(false, false) },
  unloaded: { batch: direct(true, true), single: direct(false, true) },
};

const COMPONENT_CAPS: Capabilities = Object.freeze({
  own: true,
  enumerable: false,
  budget: COMPONENT_BUDGET,
  readableWhenUnloaded: false,
  batch: false,
});

const PROXIED_CAPS: Capabilities = Object.freeze({
  own: false,
  enumerable: true,
  budget: DIRECT_BUDGET,
  readableWhenUnloaded: true,
  batch: true,
});

class DirectHost implements DpHost {
  readonly abi = 'direct';

  constructor(private readonly _target: DirectDp, readonly caps: Capabilities) {}

  read(key: string): DpValue | undefined {
    return this._target.getDynamicProperty(key);
  }

  write(key: string, value: DpValue | undefined): void {
    this._target.setDynamicProperty(key, value);
  }

  keys(): readonly string[] {
    return this._target.getDynamicPropertyIds();
  }

  bytes(): number {
    return this._target.getDynamicPropertyTotalByteCount();
  }

  writeMany(values: Record<string, DpValue | undefined>): void {
    if (this.caps.batch && this._target.setDynamicProperties) {
      this._target.setDynamicProperties(values);

      return;
    }

    for (const key of Object.keys(values)) {
      this._target.setDynamicProperty(key, values[key]);
    }
  }
}

class ComponentHost implements DpHost {
  readonly abi = 'component';
  readonly caps = COMPONENT_CAPS;

  constructor(private readonly _component: ComponentDp) {}

  read(key: string): DpValue | undefined {
    return this._component.get(key);
  }

  write(key: string, value: DpValue | undefined): void {
    this._component.set(key, value);
  }

  keys(): undefined {
    return undefined;
  }

  bytes(): number {
    return this._component.totalByteCount();
  }

  writeMany(values: Record<string, DpValue | undefined>): void {
    for (const key of Object.keys(values)) {
      this._component.set(key, values[key]);
    }
  }
}

class PrefixedHost implements DpHost {
  constructor(
    private readonly _host: DpHost,
    private readonly _prefix: string,
    readonly caps: Capabilities,
    readonly abi: HostAbi,
  ) {}

  read(key: string): DpValue | undefined {
    return this._host.read(this._prefix + key);
  }

  write(key: string, value: DpValue | undefined): void {
    this._host.write(this._prefix + key, value);
  }

  keys(): readonly string[] | undefined {
    const prefix = this._prefix;

    return this._host.keys()
      ?.filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length));
  }

  bytes(): number {
    return this._host.bytes();
  }

  writeMany(values: Record<string, DpValue | undefined>): void {
    const mapped: Record<string, DpValue | undefined> = {};

    for (const key of Object.keys(values)) {
      mapped[this._prefix + key] = values[key];
    }

    this._host.writeMany(mapped);
  }
}

/**
 * The target holds its own properties through the six-method ABI. `batch` says whether the target
 * has `setDynamicProperties`; when omitted it is probed, one native lookup — pass it where the type
 * is already known.
 */
export function directHost(target: DirectDp, options?: { readableWhenUnloaded?: boolean; batch?: boolean }): DpHost {
  const batch = options?.batch ?? typeof target.setDynamicProperties === 'function';
  const family = options?.readableWhenUnloaded === true ? DIRECT_CAPS.unloaded : DIRECT_CAPS.loaded;

  return new DirectHost(target, batch ? family.batch : family.single);
}

/** The target holds its own properties through a block entity's component. */
export function componentHost(component: ComponentDp): DpHost {
  return new ComponentHost(component);
}

/**
 * Scope a host to a prefix: every key goes through it, `keys()` lists only what is under it,
 * unprefixed. This is how collections never see each other's keys on one target, and how a
 * proxied document folds its target's identity into the world's key space. `bytes()` is still
 * the whole target's count — the engine has no per-prefix figure.
 */
export function prefixed(host: DpHost, prefix: string, caps: Capabilities = host.caps, abi: HostAbi = host.abi): DpHost {
  return new PrefixedHost(host, prefix, caps, abi);
}

/**
 * The target holds nothing of its own; its properties live on the world under a prefix that
 * carries the target's identity.
 */
export function proxiedHost(world: DirectDp, prefix: string): DpHost {
  return new PrefixedHost(directHost(world, { readableWhenUnloaded: true }), prefix, PROXIED_CAPS, 'proxied');
}
