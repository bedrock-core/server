import { describe, expect, it, vi } from 'vitest';
import { readRegistryDescriptor, readRegistryDescriptors } from '../src/registries/descriptor';
import { RegistryStore, type RegistryDefinition } from '../src/registries/store';
import { isRecord } from '../src/guards';

interface Model {
  name: string;
  textures: string[];
}

const definition: RegistryDefinition<Model> = {
  id: 'fixture:models', contract: 1,
  accepts: (value): value is Model => isRecord(value) && typeof value.name === 'string'
    && Array.isArray(value.textures) && value.textures.every(texture => typeof texture === 'string'),
};
const descriptor = { id: definition.id, contract: 1, revision: 2 };

describe('library registry records', () => {
  it('guards root collection records without freezing authored collections', () => {
    const maps: RegistryDefinition<Map<string, number>> = { id: 'fixture:maps', contract: 1, accepts: (value): value is Map<string, number> => value instanceof Map };
    const authored = new Map([['first', 1]]);
    const store = new RegistryStore({ id: maps.id, contract: 1, revision: 1 }, maps, { map: authored }, vi.fn());
    const record = store.get('map');

    expect(record?.get('first')).toBe(1);
    expect(() => record?.set('other', 2)).toThrow('read-only');
    authored.set('other', 3);
    expect(record?.has('other')).toBe(false);
    store.set('updated', authored);
    expect(() => store.get('updated')?.clear()).toThrow('read-only');
  });

  it('keeps immutable local snapshots separate from authored records and treats entry IDs as data', () => {
    const stone = { name: 'Stone', textures: ['textures/stone'] };
    const store = new RegistryStore(descriptor, definition, { 'minecraft:stone': stone }, vi.fn());

    stone.textures.push('authored-only');
    expect(store.get('minecraft:stone')).toEqual({ name: 'Stone', textures: ['textures/stone'] });
    expect(Object.isFrozen(store.get('minecraft:stone')?.textures)).toBe(true);
    expect(store.get('constructor')).toBeUndefined();
    store.set('__proto__', { name: 'Explicit', textures: [] });
    expect(store.get('__proto__')?.name).toBe('Explicit');
    expect(Object.getPrototypeOf(store.snapshot.get().entries)).toBe(Object.prototype);
    expect(store.delete('__proto__')).toBe(true);
    expect(store.get('__proto__')).toBeUndefined();
  });

  it('rejects an invalid replacement atomically and publishes one coherent snapshot per successful write', () => {
    const store = new RegistryStore(descriptor, definition, { old: { name: 'Old', textures: [] } }, vi.fn());
    const changed = vi.fn();
    const before = store.snapshot.get();
    const invalid: Model = { name: 'Invalid', textures: [] };

    Object.assign(invalid, { name: 42 });

    store.snapshot.subscribe(changed);
    expect(() => store.replace({ valid: { name: 'Valid', textures: [] }, invalid })).toThrow('invalid record');
    expect(store.snapshot.get()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect(() => store.set('', { name: 'Empty ID', textures: [] })).toThrow('nonempty');
    expect(store.delete('absent')).toBe(false);
    store.replace({ current: { name: 'Current', textures: [] } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.snapshot.get()).toEqual({ version: 1, entries: { current: { name: 'Current', textures: [] } } });
    expect(store.get('old')).toBeUndefined();
    expect(store.descriptor.revision).toBe(2);
  });

  it('withdraws records once, clears retained views and rejects stale writes', () => {
    const withdraw = vi.fn();
    const store = new RegistryStore(descriptor, definition, { old: { name: 'Old', textures: [] } }, withdraw);
    const retained = store.snapshot;

    store.stop();
    store.stop();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(retained.get().entries).toEqual({});
    expect(() => store.set('new', { name: 'New', textures: [] })).toThrow('stopped');
    expect(() => store.replace({})).toThrow('stopped');
    expect(() => store.delete('old')).toThrow('stopped');
  });
});

describe('compact registry descriptors', () => {
  it('copies only discovery fields and freezes Minecraft coverage independently of the publisher', () => {
    const authored = { ...descriptor, minecraft: { min: [1, 26, 50], max: [1, 26, 70] }, entries: { secret: 'local records' } };
    const parsed = readRegistryDescriptor(authored);

    authored.minecraft.min[2] = 99;
    expect(parsed).toEqual({ ...descriptor, minecraft: { min: [1, 26, 50], max: [1, 26, 70] } });
    expect(parsed).not.toHaveProperty('entries');
    expect(Object.isFrozen(parsed?.minecraft?.min)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { id: 'unscoped' }, { contract: 0 }, { contract: 1.5 }, { revision: -1 }, { revision: Infinity },
    { minecraft: { min: [1, 26] } }, { minecraft: { min: [1, 26, 70], max: [1, 26, 50] } },
  ])('ignores invalid publication metadata: %j', (invalid) => {
    expect(readRegistryDescriptor({ ...descriptor, ...invalid })).toBeUndefined();
  });

  it('ignores duplicate identities and malformed entries without losing unrelated descriptors', () => {
    const good = { ...descriptor, id: 'fixture:blocks' };

    expect(readRegistryDescriptors([descriptor, { ...descriptor, revision: 3 }, null, good])).toEqual([good]);
    expect(readRegistryDescriptors(undefined)).toEqual([]);
  });
});
