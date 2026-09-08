/**
 * Who may reach what on behalf of a player. The rule is the interesting half of every served
 * endpoint and the half a GameTest cannot cover: it turns on `playerPermissionLevel`, and a
 * headless world has no players to be operators. So the engine is mocked and the rule is checked
 * directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const players: { id: string; playerPermissionLevel: number; isValid: boolean }[] = [];

vi.mock('@minecraft/server', () => ({
  // The real enum: Operator is 2, and Custom is a separate bucket rather than a tier above it.
  PlayerPermissionLevel: { Visitor: 0, Member: 1, Operator: 2, Custom: 3 },
  world: { getAllPlayers: (): typeof players => players },
}));

const { authorize, denyReason } = await import('../src/authorization');

function player(id: string, level: number): void {
  players.push({ id, playerPermissionLevel: level, isValid: true });
}

describe('authorization', () => {
  beforeEach(() => { players.length = 0; });

  it('allows an addon acting for itself, with no actor', () => {
    expect(denyReason({ entity: 'someone-else' }, undefined, 'write')).toBeUndefined();
  });

  it('refuses an actor who is not in the world', () => {
    expect(denyReason({ entity: 'p1' }, 'ghost', 'read')).toMatch(/not in the world/);
  });

  it('allows an operator anywhere', () => {
    player('op', 2);

    expect(denyReason({ entity: 'someone-else' }, 'op', 'write')).toBeUndefined();
    expect(denyReason({ block: 'overworld:1,2,3:papi:elevator' }, 'op', 'write')).toBeUndefined();
    expect(denyReason({ world: true }, 'op', 'write')).toBeUndefined();
  });

  it('lets a non-operator reach their own entity', () => {
    player('p1', 1);

    expect(denyReason({ entity: 'p1' }, 'p1', 'read')).toBeUndefined();
    expect(denyReason({ entity: 'p1' }, 'p1', 'write')).toBeUndefined();
  });

  it('refuses a non-operator reaching another player, even to read', () => {
    player('p1', 1);

    expect(denyReason({ entity: 'p2' }, 'p1', 'read')).toMatch(/only reach their own/);
    expect(denyReason({ entity: 'p2' }, 'p1', 'write')).toMatch(/only reach their own/);
  });

  it('lets a non-operator read a target with no owning player, and refuses the write', () => {
    player('p1', 1);

    expect(denyReason({ world: true }, 'p1', 'read')).toBeUndefined();
    expect(denyReason({ dimension: 'nether' }, 'p1', 'read')).toBeUndefined();
    expect(denyReason({ block: 'x' }, 'p1', 'read')).toBeUndefined();
    expect(denyReason({ world: true }, 'p1', 'write')).toMatch(/only be changed by an operator/);
    expect(denyReason({ dimension: 'nether' }, 'p1', 'write')).toMatch(/only be changed by an operator/);
    expect(denyReason({ block: 'x' }, 'p1', 'write')).toMatch(/only be changed by an operator/);
  });

  it('does not treat the Custom permission bucket as operator', () => {
    player('custom', 3);

    expect(denyReason({ block: 'anything' }, 'custom', 'write')).toMatch(/operator/);
  });

  it('authorize throws the reason, so an rpc caller receives it', () => {
    player('p1', 1);

    expect(() => { authorize({ entity: 'p2' }, 'p1', 'read'); }).toThrow(/refused: a non-operator/);
    expect(() => { authorize({ entity: 'p1' }, 'p1', 'write'); }).not.toThrow();
  });
});
