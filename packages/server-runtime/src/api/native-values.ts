import { BlockPermutation, ItemLockMode, ItemStack, type RawMessage } from '@minecraft/server';
import type { Codec, NativeValue } from './types';
import { isRecord } from '../guards';

interface PermutationData {
  version: 1;
  typeId: string;
  states: Record<string, boolean | number | string>;
}

interface ItemData {
  version: 1;
  typeId: string;
  amount: number;
  nameTag?: string;
  keepOnDeath: boolean;
  lockMode: ItemLockMode;
  lore: RawMessage[];
  canDestroy: string[];
  canPlaceOn: string[];
}

function states(value: unknown): value is PermutationData['states'] {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every(state => typeof state === 'boolean'
    || typeof state === 'string' || (typeof state === 'number' && Number.isFinite(state)));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function itemData(value: unknown): value is ItemData {
  return isRecord(value) && value.version === 1 && typeof value.typeId === 'string' && value.typeId.length > 0
    && typeof value.amount === 'number' && Number.isInteger(value.amount) && value.amount >= 1 && value.amount <= 255
    && (value.nameTag === undefined || typeof value.nameTag === 'string') && typeof value.keepOnDeath === 'boolean'
    && Object.values(ItemLockMode).some(mode => value.lockMode === mode)
    && Array.isArray(value.lore) && value.lore.every(line => isRecord(line) && !Array.isArray(line))
    && strings(value.canDestroy) && strings(value.canPlaceOn);
}

/** Copy the complete native type/state value; unknown types and invalid states reject. */
export const blockPermutationCodec: Codec<BlockPermutation, unknown> = {
  encode(value) {
    if (!(value instanceof BlockPermutation)) { throw new TypeError('expected a Minecraft BlockPermutation value'); }

    return { version: 1, typeId: value.type.id, states: { ...value.getAllStates() } };
  },
  decode(value) {
    if (!isRecord(value) || value.version !== 1 || typeof value.typeId !== 'string' || !value.typeId || !states(value.states)) {
      throw new TypeError('invalid API BlockPermutation value');
    }

    const result = BlockPermutation.resolve(value.typeId, value.states);
    const resolved = result.getAllStates();

    if (result.type.id !== value.typeId || Object.keys(resolved).length !== Object.keys(value.states).length
      || Object.entries(value.states).some(([name, state]) => resolved[name] !== state)) {
      throw new TypeError('API BlockPermutation states cannot be reconstructed exactly');
    }

    return result;
  },
};

function restoreItem(value: unknown): ItemStack {
  if (!itemData(value)) { throw new TypeError('invalid API ItemStack value'); }

  const item = new ItemStack(value.typeId, value.amount);

  if (item.typeId !== value.typeId || item.amount !== value.amount || item.maxAmount <= 1) {
    throw new TypeError('API ItemStack requires a stack-compatible item and an exact amount');
  }

  item.nameTag = value.nameTag;
  item.keepOnDeath = value.keepOnDeath;
  item.lockMode = value.lockMode;
  item.setLore(value.lore);
  item.setCanDestroy(value.canDestroy);
  item.setCanPlaceOn(value.canPlaceOn);

  return item;
}

/**
 * Copy stacks whose complete native data can be verified by stacking compatibility.
 * Non-stackable or hidden-data items reject; use a ContainerSlot to access arbitrary items locally.
 */
export const itemStackCodec: Codec<ItemStack, unknown> = {
  encode(value) {
    if (!(value instanceof ItemStack)) { throw new TypeError('expected a Minecraft ItemStack value'); }

    if (value.maxAmount <= 1 || value.getDynamicPropertyIds().length > 0) {
      throw new TypeError('ItemStack fidelity cannot be verified for non-stackable or dynamic-property items; transfer a ContainerSlot instead');
    }

    const lore: RawMessage[] = JSON.parse(JSON.stringify(value.getRawLore()));
    const data: ItemData = { version: 1, typeId: value.typeId, amount: value.amount, nameTag: value.nameTag,
      keepOnDeath: value.keepOnDeath, lockMode: value.lockMode, lore,
      canDestroy: [...value.getCanDestroy()], canPlaceOn: [...value.getCanPlaceOn()] };
    const restored = restoreItem(data);

    if (!value.isStackableWith(restored)) {
      throw new TypeError('ItemStack contains data that cannot be reconstructed faithfully; transfer a ContainerSlot instead');
    }

    return data;
  },
  decode: restoreItem,
};

export const nativeValues = {
  encode(value: unknown, kind: NativeValue): unknown {
    if (kind === 'item-stack') {
      if (!(value instanceof ItemStack)) { throw new TypeError('expected a Minecraft ItemStack value'); }

      return itemStackCodec.encode(value);
    }

    if (!(value instanceof BlockPermutation)) { throw new TypeError('expected a Minecraft BlockPermutation value'); }

    return blockPermutationCodec.encode(value);
  },
  decode(value: unknown, kind: NativeValue): unknown {
    return kind === 'item-stack' ? itemStackCodec.decode(value) : blockPermutationCodec.decode(value);
  },
};
