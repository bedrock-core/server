import { isRecord } from '../guards';

/** Inclusive Minecraft version coverage for a registry dataset. */
export interface RegistryMinecraftCoverage {
  readonly min: readonly [number, number, number];
  readonly max?: readonly [number, number, number];
}

/** Discovery metadata for one dataset; records and provider identity live separately. */
export interface RegistryDescriptor {
  readonly id: string;
  /** The registry library's record contract version. */
  readonly contract: number;
  /** The publisher's dataset revision, independent of addon and runtime versions. */
  readonly revision: number;
  readonly minecraft?: RegistryMinecraftCoverage;
}

export function registryId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value);
}

function version(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0);
}

function coverage(value: unknown): RegistryMinecraftCoverage | undefined {
  if (!isRecord(value) || !version(value.min) || (value.max !== undefined && !version(value.max))) { return undefined; }

  const min = value.min;
  const max = value.max;

  if (max !== undefined) {
    const first = min.findIndex((part, index) => part !== max[index]);

    if (first >= 0 && min[first] > max[first]) { return undefined; }
  }

  return Object.freeze({ min: Object.freeze([min[0], min[1], min[2]] as const),
    ...(max === undefined ? {} : { max: Object.freeze([max[0], max[1], max[2]] as const) }) });
}

/** Validate and copy the compact fields accepted from a local publisher or a peer. */
export function readRegistryDescriptor(value: unknown): RegistryDescriptor | undefined {
  if (!isRecord(value) || !registryId(value.id)
    || typeof value.contract !== 'number' || !Number.isSafeInteger(value.contract) || value.contract < 1
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) { return undefined; }

  const minecraft = value.minecraft === undefined ? undefined : coverage(value.minecraft);

  if (value.minecraft !== undefined && minecraft === undefined) { return undefined; }

  return Object.freeze({ id: value.id, contract: value.contract, revision: value.revision,
    ...(minecraft === undefined ? {} : { minecraft }) });
}

/** Invalid and ambiguous advertisements do not supply a registry. Other addon metadata survives. */
export function readRegistryDescriptors(value: unknown): readonly RegistryDescriptor[] {
  const found = new Map<string, RegistryDescriptor>();
  const duplicates = new Set<string>();

  if (Array.isArray(value)) {
    for (const candidate of value) {
      const descriptor = readRegistryDescriptor(candidate);

      if (descriptor === undefined) { continue; }

      if (found.has(descriptor.id)) { duplicates.add(descriptor.id); }

      found.set(descriptor.id, descriptor);
    }
  }

  return Object.freeze([...found.values()].filter(descriptor => !duplicates.has(descriptor.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
