/**
 * Cross-addon translation-key sync.
 *
 * Registry display fields (`name`, `description`, `creatorName`) ARE translation keys
 * shipped in each addon's own RP `texts/*.lang`. In-game, Bedrock merges every installed
 * pack's .lang into one world-wide table, so any addon's key resolves at display time.
 * The ui-runtime layout engine, however, measures text server-side from the pack-local
 * `translationKeys.generated.json` — another addon's keys are not in it, so word-wrap/
 * ellipsis metrics would be computed on the raw key string.
 *
 * This service closes that gap: each addon publishes its generated map (the
 * `translation-keys` Regolith filter output, `@bedrock-core/generated/translation-keys`)
 * to replicated state, and `all()` merges every addon's published map — repeated keys are
 * simply overridden, mirroring how Bedrock's world-level .lang merge behaves. Use the
 * result as the `TranslationKeysContext` value:
 *
 * ```ts
 * import translationKeys from '@bedrock-core/generated/translation-keys';
 *
 * core.register({ ... });
 * core.translations.provide(translationKeys);
 *
 * // In the UI root:
 * <TranslationKeysContext value={core.translations.all()}>
 * ```
 *
 * Late joiners are covered by sync's state snapshot exchange.
 */
import type { State, Unsubscribe } from '@bedrock-core/sync';

/** State key each addon publishes its map under (namespace = the addon's transport id). */
export const TRANSLATIONS_STATE_KEY = 'bc-i18n/keys';

export type TranslationsChangeListener = () => void;

export class TranslationsRegistry {
  private readonly _state: State;
  private readonly _addonId: string;
  private readonly _listeners = new Set<TranslationsChangeListener>();
  private readonly _disposers: Unsubscribe[] = [];
  private _merged: Record<string, string> | undefined;

  constructor(state: State, addonId: string) {
    this._state = state;
    this._addonId = addonId;
  }

  start(): void {
    this._disposers.push(
      this._state.onChange((change) => {
        if (change.key !== TRANSLATIONS_STATE_KEY) { return; }

        this._merged = undefined;
        this.emitChange();
      }),
    );
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    this._listeners.clear();
    this._merged = undefined;
  }

  /**
   * Publish this addon's translation keys (the full generated map) to replicated state so
   * every addon can resolve them. Call once after `register()`; calling again replaces the
   * published map.
   */
  provide(keys: Record<string, string>): void {
    this._state.set(this._addonId, TRANSLATIONS_STATE_KEY, keys);
  }

  /**
   * The merged key → resolved-string map across every addon that called `provide()`,
   * including this one. Repeated keys are overridden by whichever map is merged later —
   * values only differ where a pack deliberately overrides another's key, mirroring
   * Bedrock's own world-level .lang merge. Reads are local-mirror only; the result is
   * cached and rebuilt when any addon re-publishes. Treat it as read-only.
   */
  all(): Record<string, string> {
    if (this._merged) { return this._merged; }

    const merged: Record<string, string> = {};

    for (const ns of this._state.namespaces()) {
      Object.assign(merged, this.publishedKeys(ns));
    }

    this._merged = merged;

    return merged;
  }

  /** The map another addon published, or `{}` if it hasn't. Local-mirror read. */
  of(addonId: string): Record<string, string> {
    return this.publishedKeys(addonId);
  }

  /** Notified when any addon's published keys change (coarse — rebuild via `all()`). */
  onChange(listener: TranslationsChangeListener): Unsubscribe {
    this._listeners.add(listener);

    return (): void => {
      this._listeners.delete(listener);
    };
  }

  private publishedKeys(ns: string): Record<string, string> {
    const value = this._state.get(ns, TRANSLATIONS_STATE_KEY);

    if (typeof value !== 'object' || value === null) { return {}; }

    const result: Record<string, string> = {};

    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') { result[key] = entry; }
    }

    return result;
  }

  private emitChange(): void {
    for (const listener of this._listeners) { listener(); }
  }
}
