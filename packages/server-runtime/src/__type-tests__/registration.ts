import type { AddonManifest, Runtime } from '../index';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- exercise inferred registration types across module boundaries
export function registerFixture(runtime: Runtime, manifest: AddonManifest) {
  return runtime.register({
    manifest,
    textureRegistry: { install: () => ({ value: { path: (id: string): string => id } }) },
  });
}
