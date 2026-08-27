/**
 * Protocol negotiation — the rule two nodes apply to decide what to speak.
 *
 * Kept apart from `discovery.ts` because it is the part with no engine in it: given what a peer
 * advertised, these answer what may be sent to it. That makes the rule testable off a running
 * server, which matters more here than in most places — an error in it does not throw, it makes
 * two addons quietly unable to hear each other.
 */
import { Cap, PROTOCOL_MAX, PROTOCOL_MIN, TAGGED_WIRE_PROTOCOL } from './constants';

/**
 * The version to speak with a peer: the newest both sides know.
 *
 * `undefined` when the ranges do not overlap — one side has moved on past what the other still
 * supports. Absent bounds mean a node from before the range was advertised, which can only be
 * {@link PROTOCOL_MIN}, since the fields ship with the version above it.
 */
export function negotiateProtocol(theirMin: number | undefined, theirMax: number | undefined): number | undefined {
  const low = typeof theirMin === 'number' ? theirMin : PROTOCOL_MIN;
  const high = typeof theirMax === 'number' ? theirMax : PROTOCOL_MIN;
  const agreed = Math.min(PROTOCOL_MAX, high);

  return agreed >= Math.max(PROTOCOL_MIN, low) ? agreed : undefined;
}

/**
 * What a peer can actually be sent, narrowed to the negotiated version: a capability advertised by
 * a node that also speaks something newer is still out of reach at the version in use.
 *
 * A node that advertised no capabilities at all but negotiated {@link TAGGED_WIRE_PROTOCOL} still
 * gets {@link Cap.Batch} — reading a batch is part of what that version means, not an extra.
 */
export function capsFor(protocol: number, advertised: readonly string[] | undefined): readonly string[] {
  if (protocol < TAGGED_WIRE_PROTOCOL) { return []; }

  return advertised ?? [Cap.Batch];
}
