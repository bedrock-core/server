import type { Runtime } from '../runtime';
import { registerTranslations, translations, publishTranslations, type Translations } from '../i18n';
import type { I18nBundle } from '@bedrock-core/i18n';

export function translationTypes(core: Runtime, bundle: I18nBundle): void {
  const registered = core.register({ manifest: core.manifest, translations: registerTranslations() });
  const accessor: Translations = registered.translations;
  const installed: Translations = translations(core);

  publishTranslations(core, bundle);
  accessor.provide(bundle);
  void installed;
  // @ts-expect-error The base Runtime type has no optional translation reader property.
  void core.translations;
  // @ts-expect-error Registered accessors cannot be replaced.
  registered.translations = accessor;
}
