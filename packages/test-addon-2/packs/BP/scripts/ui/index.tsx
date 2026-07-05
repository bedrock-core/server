import { render } from '@bedrock-core/ui-runtime';
import type { Runtime } from '@bedrock-core/server-runtime';
import { registerRuntimeCommands } from './commands';
import { App } from './App';

export function setupRuntimeUI(core: Runtime): void {
  registerRuntimeCommands((player, addonId, scope, entityId) => {
    render(<App core={core} addonId={addonId} scope={scope} entityId={entityId} />, player);
  });
}
