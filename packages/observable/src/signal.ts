import { reportListenerError, type Unsubscribe } from './observable';

/** Events without a retained value. Subscribing returns the cleanup for that subscription. */
export interface Signal<T> {
  subscribe(callback: (event: T) => void): Unsubscribe;
}

/** Create an event source. Repeated and undefined payloads are delivered independently. */
export function signal<T>(): Signal<T> & { emit(value: T): void } {
  const listeners = new Set<{ callback: (event: T) => void }>();

  return {
    subscribe(callback): Unsubscribe {
      const entry = { callback };

      listeners.add(entry);

      return (): void => { listeners.delete(entry); };
    },
    emit(value): void {
      for (const { callback } of [...listeners]) {
        try { callback(value); } catch (error) { reportListenerError('signal', error); }
      }
    },
  };
}
