/**
 * A host is where a document's bytes sit. The engine offers two ABIs for dynamic properties —
 * six methods on world, entities and container slots; three on a block entity's component — and
 * nothing at all on a dimension or a vanilla block. This file is the one adapter over all of it:
 * three verbs, one capability record, and the target's identity where it has to be part of the key.
 *
 * Every number here is measured, not assumed — see `docs/spikes/S2`, `S4` and `S5`.
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

const DIRECT_CAPS: Capabilities = {
  own: true,
  enumerable: true,
  budget: DIRECT_BUDGET,
  readableWhenUnloaded: false,
  batch: true,
};

const COMPONENT_CAPS: Capabilities = {
  own: true,
  enumerable: false,
  budget: COMPONENT_BUDGET,
  readableWhenUnloaded: false,
  batch: false,
};

const PROXIED_CAPS: Capabilities = {
  own: false,
  enumerable: true,
  budget: DIRECT_BUDGET,
  readableWhenUnloaded: true,
  batch: true,
};

/** The target holds its own properties through the six-method ABI. */
export function directHost(target: DirectDp, options?: { readableWhenUnloaded?: boolean }): DpHost {
  const batch = typeof target.setDynamicProperties === 'function';
  const caps: Capabilities = {
    ...DIRECT_CAPS,
    batch,
    readableWhenUnloaded: options?.readableWhenUnloaded ?? false,
  };

  return {
    abi: 'direct',
    caps,
    read: (key): DpValue | undefined => target.getDynamicProperty(key),
    write: (key, value): void => {
      target.setDynamicProperty(key, value);
    },
    keys: (): readonly string[] => target.getDynamicPropertyIds(),
    bytes: (): number => target.getDynamicPropertyTotalByteCount(),
    writeMany: (values): void => {
      if (target.setDynamicProperties) {
        target.setDynamicProperties(values);

        return;
      }

      for (const key of Object.keys(values)) {
        target.setDynamicProperty(key, values[key]);
      }
    },
  };
}

/** The target holds its own properties through a block entity's component. */
export function componentHost(component: ComponentDp): DpHost {
  return {
    abi: 'component',
    caps: COMPONENT_CAPS,
    read: (key): DpValue | undefined => component.get(key),
    write: (key, value): void => {
      component.set(key, value);
    },
    keys: (): undefined => undefined,
    bytes: (): number => component.totalByteCount(),
    writeMany: (values): void => {
      for (const key of Object.keys(values)) {
        component.set(key, values[key]);
      }
    },
  };
}

/**
 * Scope a host to a prefix: every key goes through it, `keys()` lists only what is under it,
 * unprefixed. This is how collections never see each other's keys on one target, and how a
 * proxied document folds its target's identity into the world's key space. `bytes()` is still
 * the whole target's count — the engine has no per-prefix figure.
 */
export function prefixed(host: DpHost, prefix: string, caps: Capabilities = host.caps, abi: HostAbi = host.abi): DpHost {
  const full = (key: string): string => prefix + key;

  return {
    abi,
    caps,
    read: (key): DpValue | undefined => host.read(full(key)),
    write: (key, value): void => {
      host.write(full(key), value);
    },
    keys: (): readonly string[] | undefined => host.keys()
      ?.filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length)),
    bytes: (): number => host.bytes(),
    writeMany: (values): void => {
      const mapped: Record<string, DpValue | undefined> = {};

      for (const key of Object.keys(values)) {
        mapped[full(key)] = values[key];
      }

      host.writeMany(mapped);
    },
  };
}

/**
 * The target holds nothing of its own; its properties live on the world under a prefix that
 * carries the target's identity.
 */
export function proxiedHost(world: DirectDp, prefix: string): DpHost {
  return prefixed(directHost(world, { readableWhenUnloaded: true }), prefix, PROXIED_CAPS, 'proxied');
}
