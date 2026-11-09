import { currentI18n, type I18nBundle } from '@bedrock-core/i18n';
import { system } from '@minecraft/server';
import type { Unsubscribe } from '@bedrock-core/observable';
import type { Runtime } from '../runtime';
import { registryOf } from '../installation';
import type { Registries } from '../registries/registry';
import type { RegistryDefinition } from '../registries/store';
import { isRecord } from '../guards';

type TranslationHost = Pick<Registries, 'publication' | 'publish'>;

/** @internal Shared contract for publishing and validating translation bundles. */
export const TRANSLATIONS: RegistryDefinition<I18nBundle> = Object.freeze({ id: 'core:translations', contract: 1, accepts: isBundle });

/** A locale table: a record whose every value is a string. An empty record qualifies. */
function isFlatMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) { return false; }

  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') { return false; }
  }

  return true;
}

function isFlatMapRecord(value: unknown): value is Record<string, Record<string, string>> {
  return isRecord(value) && Object.values(value).every(isFlatMap);
}

/** The shape `createI18n` relies on, so one addon's bad payload cannot poison the chain. */
function isBundle(value: unknown): value is I18nBundle {
  if (!isRecord(value)) { return false; }

  if (typeof value['namespace'] !== 'string' || typeof value['defaultLocale'] !== 'string') { return false; }

  if (!Array.isArray(value['libs']) || !value['libs'].every(entry => typeof entry === 'string')) { return false; }

  const args = value['args'];

  if (!isRecord(args)) { return false; }

  for (const order of Object.values(args)) {
    if (!Array.isArray(order) || !order.every(name => typeof name === 'string')) { return false; }
  }

  if (!isFlatMapRecord(value['locales'])) { return false; }

  return value['extra'] === undefined || isFlatMapRecord(value['extra']);
}

/** Replace local data independently of optional lookup and resolver code. */
function publishTranslationBundle(host: TranslationHost, owner: string, bundle: I18nBundle): void {
  const publication = host.publication(TRANSLATIONS.id);

  if (publication) { publication.set(owner, bundle); } else { host.publish(TRANSLATIONS, { revision: 1, entries: { [owner]: bundle } }); }
}

/** Publish this addon's translations without installing a translation reader. */
export function publishTranslations(runtime: Runtime, bundle: I18nBundle): void {
  publishTranslationBundle(registryOf(runtime), runtime.id, bundle);
}

/** @internal Schedule available local data under the registry host's lifetime. */
export function startTranslationPublishing(host: TranslationHost, owner: string): Unsubscribe {
  let task: number | undefined = system.run(() => {
    task = undefined;
    const bundle = currentI18n()?.bundle;

    if (bundle !== undefined && host.publication(TRANSLATIONS.id) === undefined) {
      publishTranslationBundle(host, owner, bundle);
    }
  });

  return (): void => {
    if (task !== undefined) { system.clearRun(task); task = undefined; }
  };
}
