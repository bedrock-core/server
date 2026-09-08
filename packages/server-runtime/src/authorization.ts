/**
 * Who may read and write something on behalf of a player. The one rule every served endpoint,
 * config included, applies before its handler runs.
 *
 * Nothing here defends against a hostile *pack*, which runs arbitrary script and can write the
 * underlying dynamic properties directly. What it enforces is that a **player** driving a UI or a
 * command cannot reach what is none of their business.
 *
 * So authorization keys off an ACTOR — the player a request is made on behalf of — and an absent
 * actor is allowed. An addon calling another addon's endpoint for its own reasons has no acting
 * player, is a documented framework capability, and stays open.
 */
import { PlayerPermissionLevel, world } from '@minecraft/server';
import type { Player } from '@minecraft/server';
import { isUsable } from './handle';

/** What a request is reaching, named the way a served endpoint's `access` names it. */
export type AccessTarget
  = | { world: true }
    | { dimension: string }
    | { entity: string }
    | { block: string };

export type Operation = 'read' | 'write';

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
  return isUsable(player) && player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

/**
 * Why a request made on behalf of `actorId` must be refused, or `undefined` when it is allowed.
 *
 * - No actor → allowed. An addon acting programmatically. See the file header.
 * - Actor not in the world → refused. The actor cannot be verified, so it is not trusted.
 * - Operator → allowed anywhere.
 * - Anyone else → their own entity, to read and to write; and any world, dimension or block
 *   target to read. Those are world state — a shop's prices are not a secret from the player
 *   buying — but changing them is an operator's business.
 */
export function denyReason(target: AccessTarget, actorId: string | undefined, operation: Operation): string | undefined {
  if (actorId === undefined) { return undefined; }

  const actor = world.getAllPlayers().find(candidate => candidate.id === actorId);

  if (!actor) { return `acting player '${actorId}' is not in the world`; }

  if (isOperator(actor)) { return undefined; }

  if (!('entity' in target)) {
    return operation === 'read' ? undefined : `a ${describe(target)} may only be changed by an operator`;
  }

  if (target.entity !== actorId) { return 'a non-operator may only reach their own document'; }

  return undefined;
}

/** {@link denyReason}, thrown: what a served endpoint calls before its handler runs. */
export function authorize(target: AccessTarget, actorId: string | undefined, operation: Operation): void {
  const reason = denyReason(target, actorId, operation);

  if (reason !== undefined) {
    throw new Error(`refused: ${reason}`);
  }
}

function describe(target: AccessTarget): string {
  if ('world' in target) { return 'world target'; }

  if ('dimension' in target) { return 'dimension target'; }

  return 'block target';
}
