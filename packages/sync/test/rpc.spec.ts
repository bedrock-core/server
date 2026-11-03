import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bus, EnvelopeHandler, SendOptions } from '../src/bus';
import { encodeEnvelope, type Envelope } from '../src/envelope';
import { MessageType, PROTOCOL_MAX } from '../src/constants';
import { Rpc } from '../src/rpc';

const timers = vi.hoisted(() => ({ next: 0, active: new Set<number>() }));

vi.mock('@minecraft/server', () => ({ system: {
  runTimeout: (): number => {
    const id = ++timers.next;

    timers.active.add(id);

    return id;
  },
  clearRun: (id: number): void => { timers.active.delete(id); },
} }));

function message(src: string, iid: string, type: string, data: unknown): Envelope {
  return { v: PROTOCOL_MAX, src, iid, dst: 'local', mid: 'request/1', type, data };
}

function setup(): { rpc: Rpc; receive: (envelope: Envelope) => void; sent: SendOptions[] } {
  const handlers = new Map<string, EnvelopeHandler>();
  const sent: SendOptions[] = [];
  const bus = {
    on: (type: string, handler: EnvelopeHandler): (() => void) => {
      handlers.set(type, handler);

      return (): void => { handlers.delete(type); };
    },
    send: (options: SendOptions): string => {
      encodeEnvelope(message('local', 'local/1', options.type, options.data));
      sent.push(options);

      return 'outgoing/1';
    },
  };
  // The double provides the Bus operations RPC uses.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const rpc = new Rpc(bus as unknown as Bus);

  rpc.start();

  return { rpc, receive: (envelope): void => { handlers.get(envelope.type)?.(envelope); }, sent };
}

afterEach(() => { expect(timers.active.size).toBe(0); });

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

    rpc.onRequest('invalid', (): Promise<bigint> => Promise.resolve(BigInt(1)));
    rpc.onRequest('unknown', (): never => { throw Object.create(null); });
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'invalid' }));
    receive(message('remote', 'remote/1', MessageType.Request, { method: 'unknown' }));
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[0].data).toMatchObject({ ok: false, err: 'RPC handler failed' });
    expect(sent[1].data).toMatchObject({ ok: false, err: expect.stringMatching(/JSON|BigInt|bigint/i) });
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
});
