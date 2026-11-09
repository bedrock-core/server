import type { Runtime, RuntimeServices } from '@bedrock-core/server-runtime';

declare module '@bedrock-core/server-runtime' {
  interface RuntimeServices {
    'types:counter': { readonly count: number };
  }
}

export function serviceTypes(core: Runtime): void {
  const implementation: RuntimeServices['types:counter'] = { count: 2 };

  core.provideService('types:counter', implementation);
  const count: number | undefined = core.service('types:counter')?.count;

  void count;
  // @ts-expect-error Service implementations must match their registered key's type.
  core.provideService('types:counter', { count: 'two' });
  // @ts-expect-error Service keys are declared by their owning library.
  core.service('types:unknown');
}
