/**
 * Who may reach another addon's document on behalf of a player.
 *
 * The rule is the interesting half of the db RPC and the half a GameTest cannot cover: it turns on
 * `playerPermissionLevel`, and a headless world has no players to be operators. So the engine is
 * mocked and the rule is checked directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const players: { id: string; playerPermissionLevel: number; isValid: boolean }[] = [];

vi.mock('@minecraft/server', () => ({
  // The real enum: Operator is 2, and Custom is a separate bucket rather than a tier above it.
  PlayerPermissionLevel: { Visitor: 0, Member: 1, Operator: 2, Custom: 3 },
  world: { getAllPlayers: (): typeof players => players },
}));

const { denyReason } = await import('../src/db/authorization');

function player(id: string, level: number): void {
  players.push({ id, playerPermissionLevel: level, isValid: true });
}

describe('db:authorization', () => {
  beforeEach(() => { players.length = 0; });

  it('allows an addon acting for itself, with no actor', () => {
    expect(denyReason('entity', 'someone-else', undefined)).toBeUndefined();
  });

  it('refuses an actor who is not in the world', () => {
    expect(denyReason('entity', 'p1', 'ghost')).toMatch(/not in the world/);
  });

  it('allows an operator anywhere', () => {
    player('op', 2);

    expect(denyReason('entity', 'someone-else', 'op')).toBeUndefined();
    expect(denyReason('block', 'overworld:1,2,3:papi:elevator', 'op')).toBeUndefined();
    expect(denyReason('world', 'world', 'op')).toBeUndefined();
  });

  it('lets a non-operator reach their own entity document', () => {
    player('p1', 1);

    expect(denyReason('entity', 'p1', 'p1')).toBeUndefined();
  });

  it('refuses a non-operator reaching another player', () => {
    player('p1', 1);

    expect(denyReason('entity', 'p2', 'p1')).toMatch(/only reach their own/);
  });

  it('refuses a non-operator on a document with no owning player', () => {
    player('p1', 1);

    for (const kind of ['block', 'world', 'dimension'] as const) {
      expect(denyReason(kind, 'anything', 'p1')).toMatch(/only be changed by an operator/);
    }
  });

  it('does not treat the Custom permission bucket as operator', () => {
    player('custom', 3);

    expect(denyReason('block', 'anything', 'custom')).toMatch(/operator/);
  });
});
