/** Rich-value workloads and fidelity checks shared by the Node and QuickJS benchmarks. */
export const BENCH_PROTOCOLS = [1, 2, 3] as const;

export interface StructuredPayload {
  label: string;
  value: unknown;
  valid: (value: unknown) => boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const key = { id: 'player:steve' };
const balance = { coins: 12500, items: new Set(['diamond', 'emerald']) };
const collections = { key, balance, accounts: new Map([[key, balance]]), selected: new Set([key]) };

const buffer = new ArrayBuffer(4096);
const bytes = new Uint8Array(buffer);

for (let index = 0; index < bytes.length; index++) { bytes[index] = index % 251; }

const binary = { buffer, bytes, slice: new Uint8Array(buffer, 128, 512), view: new DataView(buffer, 64, 1024) };

const sparse: unknown[] = new Array(5);

sparse[1] = undefined;
sparse[4] = 'last';
const pattern = /entry:\d+/gi;

pattern.lastIndex = 7;
const shared = { id: 'shared' };
const graph: Record<string, unknown> = {
  missing: undefined,
  bigint: 9007199254740993n,
  numbers: [NaN, Infinity, -Infinity, -0],
  sparse,
  date: new Date('2026-01-01T00:00:00.000Z'),
  pattern,
  left: shared,
  right: shared,
};

graph.self = graph;

export const STRUCTURED_PAYLOADS: readonly StructuredPayload[] = [
  {
    label: 'collections',
    value: collections,
    valid: value => record(value) && record(value.key) && record(value.balance)
      && value.accounts instanceof Map && value.selected instanceof Set
      && value.key.id === 'player:steve' && value.accounts.size === 1 && value.selected.size === 1
      && value.accounts.get(value.key) === value.balance && value.selected.has(value.key)
      && value.balance.coins === 12500 && value.balance.items instanceof Set
      && value.balance.items.size === 2 && value.balance.items.has('diamond') && value.balance.items.has('emerald'),
  },
  {
    label: 'binary-4KB',
    value: binary,
    valid: value => record(value) && value.buffer instanceof ArrayBuffer
      && value.bytes instanceof Uint8Array && value.slice instanceof Uint8Array && value.view instanceof DataView
      && value.bytes.buffer === value.buffer && value.slice.buffer === value.buffer && value.view.buffer === value.buffer
      && value.bytes.length === 4096 && value.bytes.every((byte, index) => byte === index % 251)
      && value.slice.byteOffset === 128 && value.slice.length === 512
      && value.view.byteOffset === 64 && value.view.byteLength === 1024,
  },
  {
    label: 'graph',
    value: graph,
    valid: value => record(value) && value.self === value && record(value.left)
      && value.left.id === 'shared' && value.left === value.right
      && Object.hasOwn(value, 'missing') && value.missing === undefined && value.bigint === 9007199254740993n
      && Array.isArray(value.numbers) && value.numbers.length === 4 && Number.isNaN(value.numbers[0])
      && value.numbers[1] === Infinity && value.numbers[2] === -Infinity && Object.is(value.numbers[3], -0)
      && Array.isArray(value.sparse) && value.sparse.length === 5 && !(0 in value.sparse) && !(2 in value.sparse) && !(3 in value.sparse)
      && 1 in value.sparse && value.sparse[1] === undefined && value.sparse[4] === 'last'
      && value.date instanceof Date && value.date.getTime() === 1767225600000
      && value.pattern instanceof RegExp && value.pattern.source === 'entry:\\d+'
      && value.pattern.flags === 'gi' && value.pattern.lastIndex === 7,
  },
];
