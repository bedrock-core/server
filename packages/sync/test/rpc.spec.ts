import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Bus, EnvelopeHandler, SendOptions } from '../src/bus';
import { decodeEnvelope, encodeEnvelope, type Envelope } from '../src/envelope';
import { MessageType, PROTOCOL_MAX } from '../src/constants';
import { Rpc } from '../src/rpc';

const timers = vi.hoisted(() => ({ next: 0, active: new Map<number, { callback: () => void; ticks: number }>(), cleared: [] as number[] }));

vi.mock('@minecraft/server', () => ({ system: {
  runTimeout: (callback: () => void, ticks: number): number => {
    const id = ++timers.next;

    timers.active.set(id, { callback, ticks });

    return id;
  },
  clearRun: (id: number): void => { timers.active.delete(id); timers.cleared.push(id); },
} }));

function message(src: string, iid: string, type: string, data: unknown): Envelope {
  return { v: PROTOCOL_MAX, src, iid, dst: 'local', mid: 'request/1', type, data };
}

function setup(options: { defaultTimeoutTicks?: number } = {}): {
  rpc: Rpc;
  receive: (envelope: Envelope) => void;
  sent: SendOptions[];
  send: Mock<(options: SendOptions) => string>;
  handlers: Map<string, EnvelopeHandler>;
} {
  const handlers = new Map<string, EnvelopeHandler>();
  const sent: SendOptions[] = [];
  const send = vi.fn((options: SendOptions): string => {
    encodeEnvelope(message('local', 'local/1', options.type, options.data));
    sent.push(options);

    return `outgoing/${sent.length}`;
  });
  const bus = {
    on: (type: string, handler: EnvelopeHandler): (() => void) => {
      handlers.set(type, handler);

      return (): void => { handlers.delete(type); };
    },
    send,
  };
  // The double provides the Bus operations RPC uses.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const rpc = new Rpc(bus as unknown as Bus, options);

  rpc.start();

  return { rpc, receive: (envelope: Envelope): void => { handlers.get(envelope.type)?.(envelope); }, sent, send, handlers };
}

function expire(id: number): void {
  const timer = timers.active.get(id);

  expect(timer).toBeDefined();
  timers.active.delete(id);
  timer!.callback();
}

afterEach(() => { vi.restoreAllMocks(); expect(timers.active.size).toBe(0); timers.cleared.length = 0; });

describe('RPC replies and instance ownership', () => {
  it('turns synchronous throws and immediately rejected promises into one error reply', async () => {
    const { rpc, receive, sent } = setup();

    rpc.onRequest('sync', (): never => { throw new Error('sync failed'); });
    rpc.onRequest('async', (): Promise<never> => Promise.reject(new Error('async failed')));
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'sync' }));
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'async' }));
    await Promise.resolve();
    expect(sent.map(item => item.data)).toEqual([
      { rid: 'request/1', ok: false, err: 'sync failed' },
      { rid: 'request/1', ok: false, err: 'async failed' },
    ]);
    rpc.stop();
  });

  it('reports an unsupported result and handles unstringifiable rejected values', async () => {
    const { rpc, receive, sent } = setup();

    rpc.onRequest('invalid', (): Promise<symbol> => Promise.resolve(Symbol('unsupported')));
    rpc.onRequest('unknown', (): never => { throw Object.create(null); });
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'invalid' }));
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'unknown' }));
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[0].data).toMatchObject({ ok: false, err: 'RPC handler failed' });
    expect(sent[1].data).toMatchObject({ ok: false, err: expect.stringMatching(/unsupported.*symbol/i) });
    rpc.stop();
  });

  it('accepts a response only from the requested addon and running instance', async () => {
    const { rpc, receive } = setup();
    const result = rpc.request('remote', 'read', undefined, { instanceId: 'remote/2' });

    receive(message('foreign', 'remote/2', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'wrong addon' }));
    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'old instance' }));
    expect(timers.active.size).toBe(1);
    receive(message('remote', 'remote/2', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'current' }));
    expect(await result).toBe('current');
    rpc.stop();
  });

  it('rejects requests when their target instance departs', async () => {
    const { rpc } = setup();
    const rejected = expect(rpc.request('remote', 'read', undefined, { instanceId: 'remote/1' })).rejects.toThrow(/remote.*stopped/);

    rpc.forgetPeer('remote', 'remote/1');
    await rejected;
    rpc.stop();
  });

  it('ignores unstringifiable error replies without consuming a pending call', async () => {
    const { rpc, receive } = setup();
    const result = rpc.request('remote', 'read');
    const malformed = decodeEnvelope(encodeEnvelope(message('remote', 'remote/1', MessageType.Response, {
      rid: 'outgoing/1', ok: false, err: Object.create(null),
    })));

    expect(malformed).toBeDefined();
    expect(() => receive(malformed!)).not.toThrow();
    expect(timers.active.size).toBe(1);
    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'recovered' }));
    expect(await result).toBe('recovered');
    rpc.stop();
  });

  it('retains the timeout after rejecting a malformed error payload', async () => {
    const { rpc, receive } = setup({ defaultTimeoutTicks: 20 });
    const rejected = expect(rpc.request('remote', 'read')).rejects.toThrow(/read.*remote.*timed out/);
    const [id, timer] = [...timers.active][0];

    expect(timer.ticks).toBe(20);
    expect(() => receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: false, err: { reason: 'bad shape' } }))).not.toThrow();
    expect(timers.active.size).toBe(1);
    expire(id);
    await rejected;
    rpc.stop();
  });

  it('expires only the timed-out call and ignores its late response', async () => {
    const { rpc, receive } = setup({ defaultTimeoutTicks: 60 });
    const expired = expect(rpc.request('remote', 'slow', undefined, { timeoutTicks: 2 })).rejects.toThrow('RPC \'slow\' to \'remote\' timed out');
    const waiting = rpc.request('remote', 'read');
    const [[expiredId, expiredTimer], [waitingId, waitingTimer]] = [...timers.active];

    expect(expiredTimer.ticks).toBe(2);
    expect(waitingTimer.ticks).toBe(60);
    expire(expiredId);
    await expired;
    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'late' }));
    expect([...timers.active.keys()]).toEqual([waitingId]);
    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/2', ok: true, data: 'current' }));
    expect(await waiting).toBe('current');
    expect(timers.cleared).toEqual([waitingId]);
    rpc.stop();
  });

  it('rejects all pending calls and detaches listeners when stopped', async () => {
    const { rpc, receive, sent, handlers } = setup();
    const settled = Promise.allSettled([rpc.request('one', 'read'), rpc.request('two', 'read')]);
    const timerIds = [...timers.active.keys()];

    expect(timerIds).toHaveLength(2);
    rpc.stop();
    expect(await settled).toEqual([
      { status: 'rejected', reason: new Error('RPC stopped') },
      { status: 'rejected', reason: new Error('RPC stopped') },
    ]);
    expect(timers.cleared).toEqual(timerIds);
    expect(handlers.size).toBe(0);
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'missing' }));
    expect(sent).toHaveLength(2);
  });

  it('cancels only calls affected by a departing peer instance', async () => {
    const { rpc, receive } = setup();
    const old = expect(rpc.request('remote', 'old', undefined, { instanceId: 'remote/1' })).rejects.toThrow(/remote.*stopped/);
    const current = rpc.request('remote', 'current', undefined, { instanceId: 'remote/2' });
    const unpinned = expect(rpc.request('remote', 'any')).rejects.toThrow(/remote.*stopped/);
    const other = rpc.request('other', 'read');
    const [, currentTimer, , otherTimer] = [...timers.active.keys()];

    rpc.forgetPeer('remote', 'remote/1');
    await Promise.all([old, unpinned]);
    expect([...timers.active.keys()]).toEqual([currentTimer, otherTimer]);
    receive(message('remote', 'remote/2', MessageType.Response, { rid: 'outgoing/2', ok: true, data: 'new instance' }));
    receive(message('other', 'other/1', MessageType.Response, { rid: 'outgoing/4', ok: true, data: 'other peer' }));
    expect(await current).toBe('new instance');
    expect(await other).toBe('other peer');
    rpc.stop();
  });

  it('ignores malformed and uncorrelated replies while preserving a valid pending call', async () => {
    const { rpc, receive } = setup();
    const result = rpc.request('remote', 'read');
    const malformed: unknown[] = [
      null,
      'response',
      {},
      { rid: 'outgoing/1' },
      { ok: true },
      { rid: 1, ok: true },
      { rid: 'outgoing/1', ok: 1 },
      { rid: 'unrequested', ok: true },
      { rid: 'outgoing/1', ok: false, err: null },
      { rid: 'outgoing/1', ok: false, err: 42 },
    ];

    for (const data of malformed) {
      receive(message('remote', 'remote/1', MessageType.Response, data));
      expect(timers.active.size).toBe(1);
    }

    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'valid' }));
    expect(await result).toBe('valid');
    rpc.stop();
  });

  it.each([
    [{}, 'RPC error'],
    [{ err: undefined }, 'RPC error'],
    [{ err: 'remote failed' }, 'remote failed'],
  ])('settles valid error response %j and clears its timer', async (error, expected) => {
    const { rpc, receive } = setup();
    const rejected = expect(rpc.request('remote', 'read')).rejects.toThrow(expected);

    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: false, ...error }));
    await rejected;
    expect(timers.active.size).toBe(0);
    rpc.stop();
  });

  it('ignores malformed requests and reports a valid unknown method', () => {
    const { rpc, receive, sent } = setup();
    const handler = vi.fn();

    rpc.onRequest('read', handler);

    for (const data of [null, 'request', {}, { params: 1 }, { method: 1 }]) {
      receive(message('remote', 'remote/1', MessageType.Request, data));
    }

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'missing' }));
    expect(sent).toEqual([{ dst: 'remote', type: MessageType.Response, data: { rid: 'request/1', ok: false, err: 'unknown method \'missing\'' } }]);
    rpc.stop();
  });

  it('contains send failures even when the error response also cannot be sent', async () => {
    const { rpc, receive, send } = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    rpc.onRequest('read', () => 'value');
    send.mockImplementation(() => { throw new Error('queue unavailable'); });
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'read' }));
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([options]) => options.data)).toEqual([
      { rid: 'request/1', ok: true, data: 'value' },
      { rid: 'request/1', ok: false, err: 'queue unavailable' },
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith('[sync] RPC response failed: queue unavailable');
    rpc.stop();
  });

  it('serves typed methods and retains replacement handlers when older registrations unsubscribe', async () => {
    const { rpc, receive, sent } = setup();
    const read = vi.fn((params: number, from: string) => ({ params, from }));
    const remove = rpc.serve<{ read: (params: number) => { params: number; from: string }; clear: () => void }>({ read, clear: () => undefined });

    receive(message('remote', 'remote/1', MessageType.Request, { method: 'read', params: 7 }));
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'clear' }));
    await Promise.resolve();
    expect(read).toHaveBeenCalledExactlyOnceWith(7, 'remote');
    expect(sent.map(item => item.data)).toEqual([
      { rid: 'request/1', ok: true, data: { params: 7, from: 'remote' } },
      { rid: 'request/1', ok: true },
    ]);

    const removeReplacement = rpc.onRequest('read', () => 'replacement');

    remove();
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'read' }));
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'clear' }));
    await Promise.resolve();
    expect(sent.slice(2).map(item => item.data)).toEqual([
      { rid: 'request/1', ok: false, err: 'unknown method \'clear\'' },
      { rid: 'request/1', ok: true, data: 'replacement' },
    ]);
    removeReplacement();
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'read' }));
    expect(sent.at(-1)?.data).toEqual({ rid: 'request/1', ok: false, err: 'unknown method \'read\'' });
    rpc.stop();
  });

  it('dispatches typed client calls with the method, target and parameters', async () => {
    const { rpc, receive, sent } = setup();
    const client = rpc.typed<{ read: (params: { key: string }) => string }>('remote');
    const result = client.read({ key: 'title' });

    expect(sent).toEqual([{ dst: 'remote', type: MessageType.Request, data: { method: 'read', params: { key: 'title' } } }]);
    receive(message('remote', 'remote/1', MessageType.Response, { rid: 'outgoing/1', ok: true, data: 'Title' }));
    expect(await result).toBe('Title');
    rpc.stop();
  });
});
