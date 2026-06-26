/**
 * Request/response RPC over the bus.
 *
 * `request()` sends a `req` envelope and returns a promise keyed by the envelope's message
 * id; the matching `res` envelope (correlated via `rid`) resolves or rejects it. Because
 * responses are just more script events, every request carries a tick-based timeout so a
 * peer that never answers (or was never there) can't leak a pending promise.
 */
import { system } from '@minecraft/server';
import { DEFAULT_RPC_TIMEOUT_TICKS, MessageType } from './constants';
import type { Bus, Unsubscribe } from './bus';
import type { Envelope } from './envelope';

interface RequestData {
  method: string;
  params?: unknown;
}

interface ResponseData {

  /** The request's message id. */
  rid: string;
  ok: boolean;
  data?: unknown;
  err?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: number;
}

/** Handles an inbound request. `from` is the requester's addon id. */
export type RequestHandler = (params: unknown, from: string) => unknown | Promise<unknown>;

export interface RequestOptions { timeoutTicks?: number }

export interface RpcOptions { defaultTimeoutTicks?: number }

/** A Proxy-backed client whose methods dispatch to `rpc.request(targetId, methodName, params)`. */
export type TypedClient<T> = {
  [K in keyof T]: T[K] extends (params: infer P) => infer R
    ? (params: P) => Promise<Awaited<R>>
    : never;
};

/** Handler map for `rpc.serve<T>()` — each key is type-checked against the interface. */
export type RPCHandlerMap<T> = {
  [K in keyof T]: T[K] extends (params: infer P) => infer R
    ? (params: P, from: string) => R | Promise<Awaited<R>>
    : never;
};

export class Rpc {
  private readonly _bus: Bus;
  private readonly _defaultTimeoutTicks: number;
  private readonly _handlers = new Map<string, RequestHandler>();
  private readonly _pending = new Map<string, Pending>();
  private readonly _disposers: Unsubscribe[] = [];

  constructor(bus: Bus, options: RpcOptions = {}) {
    this._bus = bus;
    this._defaultTimeoutTicks = options.defaultTimeoutTicks ?? DEFAULT_RPC_TIMEOUT_TICKS;
  }

  start(): void {
    this._disposers.push(
      this._bus.on(MessageType.Request, env => this.handleRequest(env)),
      this._bus.on(MessageType.Response, env => this.handleResponse(env)),
    );
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) dispose();
    for (const pending of this._pending.values()) {
      system.clearRun(pending.timeoutHandle);
      pending.reject(new Error('RPC stopped'));
    }
    this._pending.clear();
  }

  /** Call `method` on addon `dst`, resolving with its response or rejecting on error/timeout. */
  request(
    dst: string,
    method: string,
    params?: unknown,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const data: RequestData = { method, params };
    const mid = this._bus.send({ dst, type: MessageType.Request, data });

    const timeoutTicks = options.timeoutTicks ?? this._defaultTimeoutTicks;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = system.runTimeout(() => {
        if (!this._pending.delete(mid)) return;
        reject(new Error(`RPC '${method}' to '${dst}' timed out`));
      }, timeoutTicks);

      this._pending.set(mid, { resolve, reject, timeoutHandle });
    });
  }

  /** Returns a typed Proxy that dispatches every method call to `request(targetId, method, params)`. */
  typed<T>(targetId: string): TypedClient<T> {
    return new Proxy({} as TypedClient<T>, {
      get: (_, method) => {
        if (typeof method !== 'string') return undefined;

        return (params: unknown) => this.request(targetId, method, params);
      },
    });
  }

  /** Registers a typed handler map. Returns a single Unsubscribe that removes all handlers. */
  serve<T>(handlers: RPCHandlerMap<T>): Unsubscribe {
    const unsubs = Object.entries(handlers).map(
      ([method, handler]) => this.onRequest(method, handler as RequestHandler),
    );

    return () => { for (const u of unsubs) u(); };
  }

  /** Register the handler for `method`. Returns an unsubscribe function. */
  onRequest(method: string, handler: RequestHandler): Unsubscribe {
    this._handlers.set(method, handler);

    return (): void => {
      if (this._handlers.get(method) === handler) this._handlers.delete(method);
    };
  }

  private handleRequest(envelope: Envelope): void {
    const data = envelope.data as Partial<RequestData> | undefined;
    if (!data || typeof data.method !== 'string') return;

    const handler = this._handlers.get(data.method);
    if (!handler) {
      this.respond(envelope, { rid: envelope.mid, ok: false, err: `unknown method '${data.method}'` });

      return;
    }

    void Promise.resolve()
      .then(() => handler(data.params, envelope.src))
      .then(result => this.respond(envelope, { rid: envelope.mid, ok: true, data: result }))
      .catch((error: unknown) => this.respond(envelope, { rid: envelope.mid, ok: false, err: errorMessage(error) }));
  }

  private handleResponse(envelope: Envelope): void {
    const data = envelope.data as Partial<ResponseData> | undefined;
    if (!data || typeof data.rid !== 'string') return;

    const pending = this._pending.get(data.rid);
    if (!pending) return;

    this._pending.delete(data.rid);
    system.clearRun(pending.timeoutHandle);

    if (data.ok) {
      pending.resolve(data.data);
    } else {
      pending.reject(new Error(data.err ?? 'RPC error'));
    }
  }

  private respond(to: Envelope, data: ResponseData): void {
    this._bus.send({ dst: to.src, type: MessageType.Response, data });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
