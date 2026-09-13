/**
 * Type-level test for the config declaration's round trip through `register()`.
 *
 * The floor's `register()` is generic over the options bag: it sees only that a field holds a
 * `Declaration`, and `infer` carries the accessor type back out under the same key. So the
 * definition an addon writes must survive the trip — a declared leaf reads as its own type, and
 * everything the definition does not name is a compile error.
 *
 * `tsc` failing IS the failure, and `roundTrip` is never called: checking its body is the test.
 * Each `@ts-expect-error` also fails the build the moment the line it guards starts compiling.
 */
import type { Player } from '@minecraft/server';
import type { AddonManifest } from '../../manifest';
import type { Runtime } from '../../runtime';
import { config } from '../declaration';

/** Declares the `server` scope only, so the entity scopes carry no keys at all. */
const DEFINITION = {
  server: {
    economy: {
      $label: 'Economy',
      taxRate: { type: 'number' as const, default: 0.05, min: 0, max: 1, label: 'Tax Rate' },
    },
  },
};

declare const MANIFEST: AddonManifest;
declare const player: Player;

export function roundTrip(core: Runtime): void {
  const { config: cfg } = core.register({ manifest: MANIFEST, config: config(DEFINITION) });

  // The declared leaf comes back as its own type, though the runtime never saw the schema.
  const taxRate: number = cfg.server.economy.taxRate.get();

  void taxRate;

  // @ts-expect-error a number leaf takes a number
  cfg.server.economy.taxRate.set('high');

  // @ts-expect-error the player scope was never declared, so it holds no keys
  void cfg.player.for(player).anything;

  // @ts-expect-error the declaration names no such key
  void cfg.server.economy.discount;
}
