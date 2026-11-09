import type { Runtime, RuntimeServices } from '@bedrock-core/server-runtime';
import type { Translations } from '@bedrock-core/server-runtime/i18n';

declare module '@bedrock-core/server-runtime' {
  interface RuntimeServices {
    'types:label': { readonly text: string };
  }
}

export function mixedServices(core: Runtime): void {
  const counter: number | undefined = core.service('types:counter')?.count;
  const label: string | undefined = core.service('types:label')?.text;
  const reader: Translations | undefined = core.service('core:translations');
  const service: RuntimeServices['types:label'] = { text: 'label' };

  core.provideService('types:label', service);
  void [counter, label, reader];
  // @ts-expect-error A service implementation must match its namespaced key.
  core.provideService('types:label', { text: 1 });
  // @ts-expect-error Built-in and external augmentations do not allow unknown keys.
  core.service('types:missing');
}
