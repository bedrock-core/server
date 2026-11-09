import type { AddonManifest, Runtime } from '../index';
import { core } from '../index';
import { registerFixture } from './registration';

export function consumer(runtime: Runtime, manifest: AddonManifest): void {
  const registered = registerFixture(runtime, manifest);
  const path: string = registered.textureRegistry.path('minecraft:stone');
  const namespace: string = registered.namespace;

  void [path, namespace];
  // @ts-expect-error Returning an extended Runtime does not change singleton import types.
  void core.textureRegistry;
  // @ts-expect-error Every Runtime retains its own inferred registration contract.
  void runtime.textureRegistry;
  // @ts-expect-error Host election is not part of the Runtime.
  void runtime.host;
}
