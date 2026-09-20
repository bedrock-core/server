/**
 * Registers, and serves the one method the other pack calls. Everything this pack is for happens
 * in the other pack's tests: being discovered across a pack boundary, and answering a request
 * large enough to have crossed the wire in pieces.
 */
import { core } from '@bedrock-core/server-runtime';
import { manifest } from './addon';

core.register({ manifest });

/** The same checksum the caller computes, over what this realm reassembled. */
function checksum(value: unknown): number {
  const json = JSON.stringify(value);
  let sum = 0;

  for (let i = 0; i < json.length; i++) { sum = (sum * 31 + json.charCodeAt(i)) % 2_147_483_647; }

  return sum;
}

core.rpc.onRequest('echo', params => ({ chars: JSON.stringify(params).length, sum: checksum(params) }));
