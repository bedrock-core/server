/**
 * A small addon using `@bedrock-core/db` end to end: a per-player document on any target, and a
 * per-block document that only accepts one block type and insists on living on the block itself.
 *
 * Compiled with the package's type assertions (`yarn test:types`); it is not deployed.
 */
import { accepting, anyOf, blockTypes, entityTypes, players, schema } from '@bedrock-core/db';
import { blockCleanup, createEngineDb } from '@bedrock-core/db/minecraft';
import { Entity, system, world } from '@minecraft/server';

const db = createEngineDb('papi');

// ─── Players and the addon's own mobs: acceptors compose ───────────────────────

interface Balance {
  gold: number;
  lastSeen: number;
}

const balances = db.collection('balances', {
  // players, zombies, and every entity under the addon's namespace — for() takes a Player | Entity
  accept: anyOf(players(), entityTypes('minecraft:zombie'), accepting<Entity>(id => id.startsWith('papi:'), ['entity'])),
  schema: schema<Balance>({ defaults: { gold: 0, lastSeen: 0 } }),
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) {
    balances.for(player).patch({ lastSeen: Date.now() }); // one dynamic property on the player, written through
  }
});

// ─── Blocks: the acceptor types `for()` and gates `require` ───────────────────

interface Elevator {
  facing: 'north' | 'south' | 'east' | 'west';
  particles: boolean;
}

const elevators = db.collection('elevators', {
  schema: schema<Elevator>({
    version: 2,
    defaults: { facing: 'north', particles: true },
    migrate: {
      2: doc => ({ ...doc, facing: doc.facingDirection ?? 'north' }), // v1 called it facingDirection
    },
  }),
  accept: blockTypes('papi:elevator'),
  require: { own: true }, // papi:elevator turns on block entity dynamic_properties, so the document dies with the block
});

system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
  // papi:elevator lists both components in its JSON. This one keeps the index honest on every removal.
  blockComponentRegistry.registerCustomComponent('papi:db_block', blockCleanup(db));

  blockComponentRegistry.registerCustomComponent('papi:elevator', {
    onPlayerInteract({ block, player }) {
      const doc = elevators.for(block);

      if (!doc.available) {
        console.warn(doc.reason); // e.g. "require.own: the document would live on the world, not on the target"

        return;
      }

      const current = doc.get(); // undefined until the first write; defaults are not a document
      const particles = !(current?.particles ?? true);

      doc.patch({ particles });
      player?.sendMessage(`Particles ${particles ? 'on' : 'off'}`);
    },
  });
});

// ─── Walking the index a few per tick ──────────────────────────────────────────

let walk = elevators.all();

system.runInterval(() => {
  for (let i = 0; i < 20; i++) {
    const next = walk.next();

    if (next.done) {
      walk = elevators.all(); // start over next tick

      return;
    }

    const doc = next.value.get(); // undefined while the chunk is unloaded; a replaced block heals itself out

    if (doc?.particles) {
      // spawn particles at next.value.identity's position
    }
  }
}, 1);

// ─── A HUD reacting to a document ──────────────────────────────────────────────

world.afterEvents.playerSpawn.subscribe(({ player }) => {
  const stop = balances.for(player).subscribe((doc) => {
    player.onScreenDisplay.setActionBar(`Gold: ${doc?.gold ?? 0}`);
  });

  world.afterEvents.playerLeave.subscribe(({ playerId }) => {
    if (playerId === player.id) {
      stop();
    }
  });
});
