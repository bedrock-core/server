import { system, CustomCommandParamType, CustomCommandStatus, CommandPermissionLevel, Player } from '@minecraft/server';
import type { ConfigScope } from './routes';

type OpenCallback = (player: Player, addonId?: string, scope?: ConfigScope, entityId?: string) => void;

function resolveScope(scope: string | undefined): ConfigScope | undefined {
  if (scope === 'server' || scope === 'dimension' || scope === 'player') {
    return scope;
  }

  return undefined;
}

export function registerRuntimeCommands(onOpen: OpenCallback): void {
  system.beforeEvents.startup.subscribe((ev) => {
    const reg = ev.customCommandRegistry;

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
  });
}
