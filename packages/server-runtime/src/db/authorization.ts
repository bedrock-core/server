/**
 * Who may read and write another addon's documents on behalf of a player.
 *
 * The same boundary config draws, for the same reason: nothing here defends against a hostile
 * *pack*, which runs arbitrary script and can write the underlying dynamic properties directly.
 * What it enforces is that a **player** driving a UI or a command cannot reach a document that is
 * none of their business.
 *
 * So authorization keys off an ACTOR — the player a request is made on behalf of — and an absent
 * actor is allowed. An addon calling another addon's db for its own reasons has no acting player,
 * is a documented framework capability, and stays open.
 *
 * @see denyReason for the rule itself.
 */
import type { TargetKind } from '@bedrock-core/db';
import { world } from '@minecraft/server';
import { isOperator } from '../config/authorization';

/**
 * Why a document request made on behalf of `actorId` must be refused, or `undefined` when it is
 * allowed.
 *
 * - No actor → allowed. An addon acting programmatically. See the file header.
 * - Actor not in the world → refused. The actor cannot be verified, so it is not trusted.
 * - Operator → allowed anywhere.
 * - Anyone else → their own entity document only, matched on the identity the index keeps, which
 *   for an entity is its id.
 *
 * A block or world document has no owning player, so there is no non-operator rule that would let
 * one through: those are world state, and changing them is an operator's business.
 */
export function denyReason(
  kind: TargetKind,
  identity: string,
  actorId: string | undefined,
): string | undefined {
  if (actorId === undefined) { return undefined; }

  const actor = world.getAllPlayers().find(candidate => candidate.id === actorId);

  if (!actor) { return `acting player '${actorId}' is not in the world`; }

  if (isOperator(actor)) { return undefined; }

  if (kind !== 'entity') { return `a ${kind} document may only be changed by an operator`; }

  if (identity !== actorId) { return 'a non-operator may only reach their own document'; }

  return undefined;
}
