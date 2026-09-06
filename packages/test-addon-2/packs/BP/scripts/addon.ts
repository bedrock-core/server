/**
 * What this addon says about itself, in one place: `core.register()` declares
 * it, and the addon's page in the shared addon list bakes it.
 */
import bundle from '@bedrock-core/generated/i18n';
import { createI18n } from '@bedrock-core/i18n';

// The addon's typed verbs over its resources (packs/data/i18n). Creating the instance
// also registers it as the default translation source for any UI this addon renders.
export const i18n = createI18n(bundle);

export const manifest = {
  creator: 'drav0011',
  pack: 'shop',
  packName: i18n.key($ => $.meta.name),
  creatorName: i18n.key($ => $.meta.creator),
  version: '1.0.0',
  description: i18n.key($ => $.meta.description),
  icon: 'textures/ui/shop/icon',
  thumbnail: 'textures/ui/shop/thumbnail',
} as const;
