/** Cross-pack fixture contract for a request large enough to require framing. */
export interface PeerEcho {
  echo(value: unknown): Promise<{ chars: number; sum: number }>;
  structured(value: StructuredPayload): Promise<StructuredPayload>;
}

export interface StructuredPayload {
  key: { id: string };
  map: Map<{ id: string }, Set<{ id: string }>>;
  self?: StructuredPayload;
  missing: undefined;
  numbers: number[];
  exact: bigint;
  date: Date;
  pattern: RegExp;
  buffer: ArrayBuffer;
  bytes: Uint8Array;
  view: DataView;
  text: string;
}

export const PEER_ECHO_MODULE = '@bedrock-core/server-test-fixtures/peer';
export const peerEchoShape = {
  kind: 'object',
  members: { echo: { kind: 'function' }, structured: { kind: 'function' } },
} as const;
