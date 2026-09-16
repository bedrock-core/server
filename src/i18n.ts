/**
 * `@bedrock-core/server/i18n` — typed translations.
 *
 * Re-exports `@bedrock-core/i18n` (`createI18n`, the verbs and the display helpers) from the
 * package every addon already depends on. It is the same module `core.register()` reads the
 * translation bundle from, so the instance an addon creates is the one the runtime publishes.
 */
export * from '@bedrock-core/i18n';
