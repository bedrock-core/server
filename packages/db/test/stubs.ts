/**
 * Stubs shaped like the engine's classes, with the behaviour the ABI survey measured: a stackable
 * item throws on write, a non-stackable stack writes to a copy, a block entity answers through a
 * three-method component, a dimension holds nothing, and `getComponent` throws in an unloaded chunk.
 * `isValid` is settable so a test can make a target vanish.
 */
import { vi } from 'vitest';
import type { DirectDp, DpValue } from '../src/index';

export class DirectStub implements DirectDp {
  private readonly _props = new Map<string, DpValue>();

  getDynamicProperty(id: string): DpValue | undefined {
    return this._props.get(id);
  }

  setDynamicProperty(id: string, value?: DpValue): void {
    if (value === undefined) {
      this._props.delete(id);
    } else {
      if (typeof value === 'string' && value.length > 32_767) {
        throw new Error('ArgumentOutOfBoundsError');
      }

      this._props.set(id, value);
    }
  }

  getDynamicPropertyIds(): string[] {
    return [...this._props.keys()];
  }

  getDynamicPropertyTotalByteCount(): number {
    return [...this._props.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  }

  setDynamicProperties(values: Record<string, DpValue | undefined>): void {
    for (const key of Object.keys(values)) {
      this.setDynamicProperty(key, values[key]);
    }
  }
}

export class WorldStub extends DirectStub {
  getAllPlayers(): unknown[] {
    return [];
  }
}

export class EntityStub extends DirectStub {
  isValid = true;

  constructor(readonly id: string, readonly typeId: string) {
    super();
  }
}

export class ItemStackStub extends DirectStub {
  constructor(readonly typeId: string, readonly maxAmount: number) {
    super();
  }

  clone(): ItemStackStub {
    return new ItemStackStub(this.typeId, this.maxAmount);
  }
}

export class SlotStub extends DirectStub {
  readonly maxAmount = 64;
  isValid = true;

  constructor(private readonly _item: ItemStackStub | undefined) {
    super();
  }

  getItem(): ItemStackStub | undefined {
    return this._item;
  }
}

export class ComponentStub {
  private readonly _props = new Map<string, DpValue>();

  get(key: string): DpValue | undefined {
    return this._props.get(key);
  }

  set(key: string, value?: DpValue): void {
    if (value === undefined) {
      this._props.delete(key);
    } else {
      if (this.totalByteCount() + key.length + String(value).length > 1024) {
        throw new Error('World metadata storage limit exceeded');
      }

      this._props.set(key, value);
    }
  }

  totalByteCount(): number {
    return [...this._props.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  }
}

export class BlockStub {
  readonly permutation = {};
  isValid = true;
  readonly getComponent = vi.fn((id: string): unknown => (id === 'minecraft:dynamic_properties' ? this._component : undefined));

  constructor(
    readonly typeId: string,
    readonly location: { x: number; y: number; z: number },
    readonly dimension: { id: string },
    private readonly _component: ComponentStub | undefined,
  ) {}
}

export class DimensionStub {
  constructor(readonly id: string) {}

  getBlock(): undefined {
    return undefined;
  }
}
