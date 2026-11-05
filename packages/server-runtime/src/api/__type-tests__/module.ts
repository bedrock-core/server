import type { Observable, ReadonlyObservable, Signal } from '@bedrock-core/observable';
import type { Runtime } from '../../runtime';
import type * as Public from '../../index';
import type { ApiModule } from '../../api';
import type { Entity, Player } from '@minecraft/server';

class Money {
  static readonly codec: Public.Codec<Money, number> = {
    encode: value => value.gold,
    decode: gold => new Money(gold),
  };

  constructor(readonly gold: number) {}

  format(): string { return `${this.gold} gold`; }
}

interface Authored {
  world: {
    afterEvents: { dropped: Signal<{ entity: Entity | undefined; price: Money }> };
    selected: ReadonlyObservable<Player | undefined>;
    quote(player: Player, confirm: (entity: Entity, price: Money) => Promise<Money>): Promise<Money>;
  };
  Money: typeof Money;
  funds: ReadonlyObservable<Money | undefined>;
  quoted: Signal<Money>;
  purchase(price: Money, confirm: (price: Money, note?: string) => Promise<Money>): Promise<Money>;
  balance(playerId: string, amount: number, actorId?: string): Promise<{ gold: number }>;
  synchronous(): number;
  currency: Observable<{ label: string }>;
  changed: Signal<{ playerId: string; gold: number }> & { emit(value: { playerId: string; gold: number }): void };
  info: { readonly unit: 'Gold'; readonly limits: readonly [1, 10] };
}

function consumer(api: ApiModule<Authored>): void {
  api.world.afterEvents.dropped.subscribe((event) => {
    const reference: Entity | undefined = event.entity;

    if (reference) { reference.nameTag = event.price.format(); }

    // @ts-expect-error event containers remain readonly
    event.entity = undefined;
  });
  const selected: Player | undefined = api.world.selected.get();

  if (selected) {
    selected.nameTag = 'native setter';
    void api.world.quote(selected, async (_entity, price) => price);
  }

  const money = new api.Money(3);
  const result: Promise<Money> = api.purchase(money, async (price, note) => {
    const label: string = price.format();
    const optional: string | undefined = note;

    void [label, optional];

    return new api.Money(price.gold);
  });
  const formatted: string | undefined = api.funds.get()?.format();

  api.quoted.subscribe((value) => {
    const text: string = value.format();

    void text;
  });
  // @ts-expect-error callbacks preserve their async result contract
  void api.purchase(money, price => price);
  // @ts-expect-error class snapshot fields remain readonly
  api.funds.get()!.gold = 4;

  const value: Promise<{ gold: number }> = api.balance('player', 2, undefined);
  const snapshot: { readonly label: string } | undefined = api.currency.get();
  const unit: 'Gold' = api.info.unit;

  api.currency.subscribe((next, prev) => {
    const current: string | undefined = next?.label;
    const previous: string | undefined = prev?.label;

    void [current, previous];
  });
  api.changed.subscribe((event) => {
    const id: string = event.playerId;

    void id;
    // @ts-expect-error event payloads are readonly snapshots
    event.gold = 1;
  });
  // @ts-expect-error tuple arguments preserve required positional parameters
  api.balance('player');
  // @ts-expect-error tuple argument types remain exact
  api.balance(2, 'player');
  // @ts-expect-error public functions must be asynchronous
  api.synchronous();
  // @ts-expect-error consumer state cannot be mutated
  api.currency.set({ label: 'Coins' });
  // @ts-expect-error snapshots can be missing before arrival and after disconnect
  const required: { label: string } = api.currency.get();

  // @ts-expect-error nested constants cannot be reassigned
  api.info.unit = 'Gold';
  // @ts-expect-error readonly event consumers cannot emit
  api.changed.emit({ playerId: 'p', gold: 1 });

  const observable: ReadonlyObservable<{ readonly label: string } | undefined> = api.currency;
  const signal: Signal<{ readonly playerId: string; readonly gold: number }> = api.changed;

  void [value, snapshot, unit, required, observable, signal, result, formatted];
}

void consumer;

function authoring(
  runtime: Runtime,
  manifest: Public.AddonManifest,
  API: { currency: Observable<string>; changed: Signal<number> & { emit(value: number): void } },
  registerApi: typeof Public.registerApi,
): void {
  const declaration: Public.ApiDeclaration<typeof API> = registerApi(API);
  const { api } = runtime.register({ manifest, api: declaration });
  const implementation: typeof API = api;

  api.currency.set('gold');
  api.changed.emit(1);
  void implementation;
}

void authoring;

function runtimeSurface(runtime: Runtime): void {
  // @ts-expect-error raw transport is private to the runtime implementation
  void runtime.rpc;
  // @ts-expect-error raw node is private to the runtime implementation
  void runtime.node;
  // @ts-expect-error API state use normal observable exports
  void runtime.shared;
  // @ts-expect-error API events use normal Signal exports
  void runtime.events;
  // @ts-expect-error transport lifecycle is not a public API operation
  void runtime.api.start;
  // @ts-expect-error transport lifecycle is owned by Runtime.stop
  void runtime.api.stop;
}

void runtimeSurface;

type UnavailablePublicTypes = {
  // @ts-expect-error raw RPC contracts are not reexported by the runtime
  rpc: Public.RPCHandlerMap<never>;
  // @ts-expect-error raw RPC clients are not reexported by the runtime
  client: Public.TypedClient<never>;
  // @ts-expect-error the mirror feed is an implementation detail
  announcement: Public.Announcement<never>;
  // @ts-expect-error generated binding metadata is not part of the root API
  shape: Public.ApiShape;
};

function unavailable(_types: UnavailablePublicTypes): void {}

void unavailable;
