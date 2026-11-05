import type { AddonManifest } from '@bedrock-core/server-runtime';
import manifest from '../../manifest.json';

/** Preserve the owning pack's native identity while selecting a test runtime namespace. */
export function testManifest(namespace: string, name: string, optionalDependencies: NonNullable<AddonManifest['optionalDependencies']> = []): AddonManifest {
  return {
    ...manifest,
    namespace,
    header: { ...manifest.header, name },
    ...(optionalDependencies.length ? { optionalDependencies } : {}),
  };
}
