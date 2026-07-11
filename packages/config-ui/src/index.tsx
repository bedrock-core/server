/**
 * `@bedrock-core/config-ui` — the addon list + config UI every bedrock-core addon
 * mounts with one line:
 *
 * ```ts
 * import { core } from '@bedrock-core/server-runtime';
 * import { setupConfigUI } from '@bedrock-core/config-ui';
 *
 * core.register({ ... });
 * setupConfigUI(core);
 * ```
 *
 * The `core:config` command registration is first-wins across realms (see
 * `commands.ts`); the winning realm renders the UI for every addon, since the
 * registry, config schemas, and translation keys all replicate over sync.
 */
import { render } from '@bedrock-core/ui-runtime';
import type { Runtime } from '@bedrock-core/server-runtime';
import { registerRuntimeCommands } from './commands';
import { App } from './App';

export { App } from './App';
export type { AppProps } from './App';
export type { AppRoutes, AppScreen, ConfigScope, EntrySchema } from './routes';

export function setupConfigUI(core: Runtime): void {
  registerRuntimeCommands((player, addonId, scope, entityId) => {
    render(<App core={core} addonId={addonId} scope={scope} entityId={entityId} />, player);
  });
}
