/** Cross-pack fixture contract for a request large enough to require framing. */
export interface PeerEcho {
  echo(value: unknown): Promise<{ chars: number; sum: number }>;
}

export const PEER_ECHO_MODULE = '@bedrock-core/server-test-fixtures/peer';
export const peerEchoShape = {
  kind: 'object',
  members: { echo: { kind: 'function' } },
} as const;
