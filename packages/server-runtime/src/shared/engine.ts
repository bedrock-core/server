/**
 * The engine half of `core.shared`: the world's dynamic properties as the persistence store, and
 * `system.run` as the one-tick deferral dynamic properties need before they can be read.
 */
import { system, world } from '@minecraft/server';
import type { PersistenceStore } from './shared-registry';

export const worldStore: PersistenceStore = {
  read(key: string): string | undefined {
    const value = world.getDynamicProperty(key);

    return typeof value === 'string' ? value : undefined;
  },

  write(key: string, value: string | undefined): void {
    world.setDynamicProperty(key, value);
  },
};

export function deferToNextTick(fn: () => void): void {
  system.run(fn);
}
