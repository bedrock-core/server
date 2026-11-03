import { last, observable, signal, toSignal, type NativeSignal, type ReadonlyObservable, type Signal, type Unsubscribe } from '../src/index';
import type { EntityDieAfterEvent, EntityDieAfterEventSignal, EntityEventOptions } from '@minecraft/server';

function contracts(): void {
  const producer = signal<{ value: number }>();
  const consumer: Signal<{ value: number }> = producer;
  const release: Unsubscribe = consumer.subscribe((payload) => { void payload.value; });
  const value: ReadonlyObservable<number> = observable(0);
  const releaseValue: Unsubscribe = value.subscribe(() => undefined);

  // @ts-expect-error observables have no explicit unsubscribe method
  value.unsubscribe(() => undefined);
  // @ts-expect-error observable subscriptions have no native filter options
  value.subscribe(() => undefined, {});
  releaseValue();
  // @ts-expect-error consumer Signal has no emission operation
  consumer.emit({ value: 2 });
  // @ts-expect-error signals have no retained value
  consumer.get();
  // @ts-expect-error core subscriptions have no explicit unsubscribe method
  consumer.unsubscribe(() => undefined);
  // @ts-expect-error core subscriptions have no native filter options
  consumer.subscribe(() => undefined, { entities: ['minecraft:pig'] });

  const native: NativeSignal<{ entityId: string }, { entities: string[] }> = {
    subscribe: callback => callback,
    unsubscribe: () => undefined,
  };
  const events: Signal<{ entityId: string }> = toSignal(native, { entities: ['minecraft:pig'] });
  const stop: Unsubscribe = events.subscribe((event) => { void event.entityId; });

  // @ts-expect-error native and core subscription returns are distinct
  const invalid: Signal<{ entityId: string }> = native;
  // @ts-expect-error native sources require explicit removal
  const missing: NativeSignal<number> = { subscribe: callback => callback };

  // @ts-expect-error source-specific filter options retain their declared types
  toSignal(native, { entities: 1 });
  // @ts-expect-error converter input uses the native callback-removal convention
  toSignal(producer);

  const latest = last(native, { on: { entities: ['minecraft:pig'] } });
  const payload: { entityId: string } | undefined = latest.get();

  // @ts-expect-error native SDK filter options retain their own type
  last(native, { on: { entities: 1 } });
  void [invalid, missing, payload];
  stop();
  release();
}

function minecraftContract(source: EntityDieAfterEventSignal, options: EntityEventOptions): void {
  const native: NativeSignal<EntityDieAfterEvent, EntityEventOptions> = source;
  const events = toSignal(native, options);
  const stop: Unsubscribe = events.subscribe((event) => {
    const payload: EntityDieAfterEvent = event;

    void payload;
  });

  stop();
}

void [contracts, minecraftContract];
