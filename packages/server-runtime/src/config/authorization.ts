/**
 * Who may read and write config on behalf of a player.
 *
 * ## What this does and does not defend against
 *
 * Every addon in a world runs arbitrary script and can write the underlying dynamic
 * properties directly, so nothing here can stop a hostile *pack*. The boundary this enforces
 * is the one that actually exists: a **player** driving the config UI or a config command
 * must not be able to change settings they have no business changing.
 *
 * That is why authorization keys off an ACTOR — the player a request is made on behalf of —
 * and why an absent actor is allowed through. `core.config.of(id).server.patch(...)` called
 * by an addon for its own reasons has no acting player, is a documented framework capability,
 * and stays open.
 *
 * @see denyReason for the rule itself.
 */
import { PlayerPermissionLevel, world } from '@minecraft/server';
import type { Player } from '@minecraft/server';

/** The three config scopes, named as they appear on the wire. */
export type ConfigScopeName = 'server' | 'dimension' | 'player';

/**
 * Whether the player is a world operator.
 *
 * Deliberately reads `playerPermissionLevel`, which is **readonly** on `Player`, and not
 * `commandPermissionLevel`, which is a mutable property any script in the world can rewrite —
 * authorization must never rest on a value another addon can hand itself.
 *
 * `PlayerPermissionLevel.Custom` is not accepted: it is a separate bucket, not a tier above
 * `Operator`, so treating it as "at least operator" would grant more than the name implies.
 */
export function isOperator(player: Player): boolean {
  return player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

/**
 * Why a config request made on behalf of `actorId` must be refused, or `undefined` when it is
 * allowed. Used for every write, and for player-scope reads (one player's settings are not
 * another player's business).
 *
 * - No actor → allowed. An addon acting programmatically, not a player. See the file header.
 * - Actor not in the world → refused. The actor cannot be verified, so it is not trusted.
 * - Operator → allowed anywhere.
 * - Anyone else → their own player scope only.
 */
export function denyReason(
  scope: ConfigScopeName,
  actorId: string | undefined,
  targetId: string | undefined,
): string | undefined {
  if (actorId === undefined) { return undefined; }

  const actor = world.getAllPlayers().find(candidate => candidate.id === actorId);

  if (!actor) { return `acting player '${actorId}' is not in the world`; }

  if (isOperator(actor)) { return undefined; }

  if (scope !== 'player') { return `${scope} config may only be changed by an operator`; }

  if (targetId !== actorId) { return 'a non-operator may only reach their own player config'; }

  return undefined;
}
