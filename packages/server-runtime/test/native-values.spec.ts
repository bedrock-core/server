import { describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => {
  class ItemStack {
    amount: number;
    readonly maxAmount: number;
    nameTag?: string;
    keepOnDeath = false;
    lockMode = 'none';
    lore: Record<string, unknown>[] = [];
    canDestroy: string[] = [];
    canPlaceOn: string[] = [];
    dynamicProperties: string[] = [];
    hiddenData?: string;
    constructor(readonly typeId: string, amount = 1) {
      this.maxAmount = typeId === 'minecraft:diamond_sword' ? 1 : 64;
      this.amount = Math.min(amount, this.maxAmount);
    }

    getDynamicPropertyIds(): string[] { return this.dynamicProperties; }
    getRawLore(): Record<string, unknown>[] { return this.lore; }
    getCanDestroy(): string[] { return this.canDestroy; }
    getCanPlaceOn(): string[] { return this.canPlaceOn; }
    setLore(lore: Record<string, unknown>[]): void { this.lore = JSON.parse(JSON.stringify(lore)); }
    setCanDestroy(values: string[]): void { this.canDestroy = [...values]; }
    setCanPlaceOn(values: string[]): void { this.canPlaceOn = [...values]; }
    isStackableWith(other: ItemStack): boolean {
      return this.maxAmount > 1 && JSON.stringify({ ...this, amount: 1 }) === JSON.stringify({ ...other, amount: 1 });
    }
  }
  class BlockPermutation {
    readonly type: { id: string };
    constructor(typeId: string, readonly states: Record<string, boolean | string | number>) { this.type = { id: typeId }; }
    getAllStates(): Record<string, boolean | string | number> { return { ...this.states }; }
    static resolve(typeId: string, states: Record<string, boolean | string | number>): BlockPermutation {
      if (typeId !== 'minecraft:oak_log') { throw new Error('unknown block'); }

      return new BlockPermutation(typeId, { axis: 'y', enabled: true, count: 1, ...states });
    }
  }

  return { ItemStack, BlockPermutation };
});

vi.mock('@minecraft/server', () => ({ ...engine, ItemLockMode: { none: 'none', inventory: 'lock_in_inventory', slot: 'lock_in_slot' } }));

const { nativeValues } = await import('../src/api/native-values');
const { transformData, freezeApiData } = await import('../src/api/codec');
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('native value codecs', () => {
  it('copies every block state into an independent native permutation', () => {
    const original = new engine.BlockPermutation('minecraft:oak_log', { axis: 'x', enabled: false, count: 4 });
    const encoded = nativeValues.encode(original, 'block-permutation');
    const decoded = nativeValues.decode(wire(encoded), 'block-permutation');

    expect(decoded).toBeInstanceOf(engine.BlockPermutation);
    expect(decoded).not.toBe(original);
    expect(decoded).toEqual(original);
  });

  it('rejects malformed, nonfinite, incomplete and unknown permutation payloads', () => {
    expect(() => nativeValues.decode({ version: 1, typeId: 'minecraft:oak_log', states: { count: Infinity } }, 'block-permutation')).toThrow('invalid API');
    expect(() => nativeValues.decode({ version: 1, typeId: 'minecraft:oak_log', states: {} }, 'block-permutation')).toThrow('exactly');
    expect(() => nativeValues.decode({ version: 1, typeId: 'missing:block', states: {} }, 'block-permutation')).toThrow('unknown block');
    expect(() => nativeValues.encode({}, 'block-permutation')).toThrow('BlockPermutation');
  });

  it('round trips item metadata and raw translated lore without sharing mutable data', () => {
    const original = new engine.ItemStack('minecraft:stone', 7);

    original.nameTag = 'Named stone';
    original.keepOnDeath = true;
    original.lockMode = 'lock_in_slot';
    original.lore = [{ translate: 'item.name', with: ['Example'] }];
    original.canDestroy = ['minecraft:dirt'];
    original.canPlaceOn = ['minecraft:stone'];
    const encoded = nativeValues.encode(original, 'item-stack');
    const decoded = nativeValues.decode(wire(encoded), 'item-stack');

    expect(decoded).toBeInstanceOf(engine.ItemStack);
    expect(decoded).toEqual(original);
    original.lore[0].translate = 'changed';
    original.canDestroy.push('minecraft:stone');
    expect(nativeValues.decode(wire(encoded), 'item-stack')).toEqual(decoded);
  });

  it('rejects hidden item data, non-stackable items and dynamic properties', () => {
    const hidden = new engine.ItemStack('minecraft:stone');
    const dynamic = new engine.ItemStack('minecraft:stone');

    hidden.hiddenData = 'unreadable native data';
    dynamic.dynamicProperties.push('addon:value');
    expect(() => nativeValues.encode(hidden, 'item-stack')).toThrow('faithfully');
    expect(() => nativeValues.encode(dynamic, 'item-stack')).toThrow('fidelity');
    expect(() => nativeValues.encode(new engine.ItemStack('minecraft:diamond_sword'), 'item-stack')).toThrow('fidelity');
  });

  it('rejects invalid amounts and lock modes instead of accepting native clamping', () => {
    const data = nativeValues.encode(new engine.ItemStack('minecraft:stone'), 'item-stack');

    if (typeof data !== 'object' || data === null) { throw new Error('expected item data'); }

    expect(() => nativeValues.decode({ ...data, amount: 65 }, 'item-stack')).toThrow('exact amount');
    expect(() => nativeValues.decode({ ...data, amount: 1.5 }, 'item-stack')).toThrow('invalid API');
    expect(() => nativeValues.decode({ ...data, lockMode: 'unknown' }, 'item-stack')).toThrow('invalid API');
  });

  it('preserves nullable native values and keeps decoded SDK snapshots usable', () => {
    const shape = { kind: 'native-value', value: 'item-stack' } as const;
    const original = new engine.ItemStack('minecraft:stone', 4);
    const context = { values: nativeValues };
    const decoded = transformData(wire(transformData(original, shape, 'encode', context)), shape, 'decode', context);

    expect(transformData(null, shape, 'encode')).toBeNull();
    expect(transformData(undefined, shape, 'decode')).toBeUndefined();
    expect(freezeApiData(decoded, shape)).toBe(decoded);
    expect(Object.isFrozen(decoded)).toBe(false);
    expect(decoded).not.toBe(original);
  });
});
