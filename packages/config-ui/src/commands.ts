import { system, CustomCommandParamType, CustomCommandStatus, CommandPermissionLevel, Player } from '@minecraft/server';
import type { ConfigScope } from './routes';

type OpenCallback = (player: Player, addonId?: string, scope?: ConfigScope, entityId?: string) => void;

function resolveScope(scope: string | undefined): ConfigScope | undefined {
  if (scope === 'server' || scope === 'dimension' || scope === 'player') {
    return scope;
  }

  return undefined;
}

/**
 * Register the `core:config` command — first realm wins.
 *
 * Every bedrock-core addon mounts this UI, but Bedrock's custom-command registry is
 * world-global and duplicate identifiers throw. The first pack to load registers the
 * command and its realm serves the config UI for EVERY addon (the UI reads registry,
 * config, and translations over sync state, so any single realm can render it all).
 * Later realms catch the duplicate error and stand down. Which addon's copy serves is
 * load-order dependent, so addons built against different config-ui versions may serve
 * an older UI — acceptable, since the data contract flows over sync.
 */
export function registerRuntimeCommands(onOpen: OpenCallback): void {
  system.beforeEvents.startup.subscribe((ev) => {
    const reg = ev.customCommandRegistry;

    try {
      reg.registerCommand(
        {
          name: 'core:config',
          description: 'Open the config UI. Usage: core:config [addonId] [scope] [entityId]',
          permissionLevel: CommandPermissionLevel.Any,
          optionalParameters: [
            { name: 'addonId', type: CustomCommandParamType.String },
            { name: 'scope', type: CustomCommandParamType.String },
            { name: 'entityId', type: CustomCommandParamType.String },
          ],
        },
        (origin, addonId?: string, scope?: string, entityId?: string) => {
          if (!(origin.sourceEntity instanceof Player)) {
            return { status: CustomCommandStatus.Failure, message: 'Must be run by a player' };
          }

          const player = origin.sourceEntity;
          const resolvedScope = resolveScope(scope);

          system.run(() => onOpen(player, addonId, resolvedScope, entityId));

          return { status: CustomCommandStatus.Success };
        },
      );
    } catch {
      console.info('[config-ui] core:config is already registered by another addon - this realm will not serve the config UI');
    }
  });
}
