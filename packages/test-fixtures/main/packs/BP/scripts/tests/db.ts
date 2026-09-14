/**
 * GameTests for `@bedrock-core/db` — the half its unit tests cannot reach.
 *
 * `packages/db/test` runs against stubs shaped like the engine's classes, so every fact those
 * stubs encode is an assumption until something asserts it on a real server: the two ABIs and
 * what each can do, the 32 767-character property cap and the ~950 bytes a block entity holds,
 * an `ItemStack` write landing on a copy, a stackable slot throwing, a dropped block taking its
 * document and its index entry with it. Those are the measurements in `docs/spikes/S4`, `S5` and
 * `S8`; here they are assertions, so a Bedrock release that moves one of them turns this suite
 * red instead of silently breaking the library.
 *
 * Everything runs on `core.db` rather than a fresh runtime: the block cleanup component in
 * `../main` is registered against that db, and only the db it heals can prove the healing. Each
 * test therefore uses its own collection name and deletes what it wrote.
 */
import { BlockPermutation, ItemStack, world } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import { COMPONENT_BUDGET, DIRECT_BUDGET, type Capabilities, type Where } from '@bedrock-core/db';
import { DbBudgetError, blockTypes, core, entityTypes, schema, slots } from '@bedrock-core/server-runtime';

const STRUCTURE = 'core:empty';

/** The fixture's own block type: `minecraft:block_entity` with `dynamic_properties`. */
const PROBE_BLOCK = 'core_fixture:db_probe';

function gametest(name: string, fn: (test: Test) => void): void {
  register('core', name, fn).structureName(STRUCTURE).tag('core').maxTicks(220);
}

/** The capabilities a collection reports for a target, or `undefined` after failing the test. */
function capsOf(test: Test, where: Where, label: string): Capabilities | undefined {
  if (!where.ok) {
    test.fail(`${label}: refused — ${where.reason}`);

    return undefined;
  }

  return where.caps;
}

/** Why a collection refused a target, or `undefined` after failing the test because it did not. */
function refusalOf(test: Test, where: Where, label: string): string | undefined {
  if (where.ok) {
    test.fail(`${label}: accepted, expected a refusal`);

    return undefined;
  }

  return where.reason;
}

// The direct ABI, on the three targets that have it, plus the one that has none. What the stubs
// claim per kind — own, enumerable, batch, the budget, and whether a write survives the handle it
// was made through — asked of the engine.
gametest('db_direct_abi', (test) => {
  const notes = core.db.collection('t_abi', { schema: schema<{ text: string }>({ defaults: { text: '' } }) });
  const stand = test.spawn('minecraft:armor_stand', { x: 1, y: 1, z: 1 });
  const dimension = test.getDimension();

  test.startSequence()
    .thenIdle(5)
    .thenExecute(() => {
      const onWorld = capsOf(test, notes.where(world), 'world');
      const onEntity = capsOf(test, notes.where(stand), 'entity');
      const onDimension = capsOf(test, notes.where(dimension), 'dimension');

      if (onWorld === undefined || onEntity === undefined || onDimension === undefined) { return; }

      for (const [label, caps] of [['world', onWorld], ['entity', onEntity]] as const) {
        if (!caps.own || !caps.enumerable || !caps.batch || caps.budget !== DIRECT_BUDGET) {
          test.fail(`${label} is no longer the direct ABI: ${JSON.stringify(caps)}`);
        }
      }

      // A dimension holds nothing of its own, so its document lives on the world under its identity.
      if (onDimension.own || !onDimension.readableWhenUnloaded) {
        test.fail(`a dimension should be proxied to the world: ${JSON.stringify(onDimension)}`);
      }

      notes.for(stand).set({ text: 'kept' });
      notes.for(dimension).set({ text: 'proxied' });
    })
    .thenIdle(5)
    .thenExecute(() => {
      // The handle the write went through is gone; the engine is asked for the target again.
      const again = world.getEntity(stand.id);

      if (again === undefined) {
        test.fail('the armor stand vanished');

        return;
      }

      notes.forget(stand);

      if (notes.for(again).get()?.text !== 'kept') {
        test.fail(`an entity write did not survive a fresh handle: ${JSON.stringify(notes.for(again).get())}`);
      }

      notes.forget(dimension);

      const proxied = notes.for(world.getDimension(dimension.id)).get();

      if (proxied?.text !== 'proxied') { test.fail(`a dimension document read back ${JSON.stringify(proxied)}`); }

      // The proxied document is the world's, so it outlives the test unless it is removed.
      notes.for(dimension).delete();
      notes.for(again).delete();

      if (notes.for(world.getDimension(dimension.id)).get() !== undefined) { test.fail('the dimension document survived its delete'); }
    })
    .thenSucceed();
});

// The property cap the whole direct family is sized from, and what the store does at it: a
// document past the cap is split across properties rather than refused, and its delete takes
// every piece with it.
gametest('db_direct_budget', (test) => {
  const blobs = core.db.collection('t_budget', {
    schema: schema<{ blob: string }>({ defaults: { blob: '' } }),
    accept: entityTypes('minecraft:armor_stand'),
  });
  const stand = test.spawn('minecraft:armor_stand', { x: 1, y: 1, z: 1 });
  const blob = 'x'.repeat(DIRECT_BUDGET + 5_000);

  test.startSequence()
    .thenIdle(5)
    .thenExecute(() => {
      stand.setDynamicProperty('core_fixture:probe', 'a'.repeat(DIRECT_BUDGET));

      let threw: string | undefined;

      try {
        stand.setDynamicProperty('core_fixture:probe', 'a'.repeat(DIRECT_BUDGET + 1));
      } catch (error) {
        threw = String(error);
      }

      if (threw === undefined) { test.fail(`${DIRECT_BUDGET + 1} characters were accepted — DIRECT_BUDGET is no longer the cap`); }

      stand.setDynamicProperty('core_fixture:probe', undefined);
      blobs.for(stand).set({ blob });
      blobs.forget(stand);
    })
    .thenIdle(5)
    .thenExecute(() => {
      const read = blobs.for(stand).get();

      if (read?.blob !== blob) {
        test.fail(`the chunked document came back ${read === undefined ? 'undefined' : `${read.blob.length} characters`}, expected ${blob.length}`);
      }

      blobs.for(stand).delete();

      const left = stand.getDynamicPropertyIds().filter(id => id.includes('t_budget'));

      if (left.length !== 0) { test.fail(`delete left ${JSON.stringify(left)} behind`); }
    })
    .thenSucceed();
});

// The component ABI on a real block entity: its capabilities, its much smaller budget, and the
// removal path — `blockCleanup` in `../main` drops the index entry, and the block entity takes
// the document itself. Re-placing the type gives a fresh document, never the old one.
gametest('db_block_entity', (test) => {
  const probes = core.db.collection('t_blocks', {
    schema: schema<{ hits: number; note: string }>({ defaults: { hits: 0, note: '' } }),
    accept: blockTypes(PROBE_BLOCK),
    require: { own: true },
  });
  // Offered on a block and refused: the document could die with the block before the flush.
  const counters = core.db.collection('t_block_coalesce', {
    schema: schema<{ n: number }>({ defaults: { n: 0 } }),
    accept: blockTypes(PROBE_BLOCK),
    coalesce: true,
  });
  const at = { x: 1, y: 1, z: 1 };
  const air = BlockPermutation.resolve('minecraft:air');
  // A failed sequence step still runs the ones after it, and a completed test refuses every
  // method — so once something has failed, the rest of the sequence stands down.
  let failed = false;

  const fail = (message: string): void => {
    failed = true;
    test.fail(message);
  };

  test.startSequence()
    .thenExecute(() => { test.setBlockType(PROBE_BLOCK, at); })
    .thenIdle(4)
    .thenExecute(() => {
      const block = test.getBlock(at);
      const caps = capsOf(test, probes.where(block), 'block');

      if (caps === undefined) {
        failed = true;

        return;
      }

      if (!caps.own || caps.enumerable || caps.budget !== COMPONENT_BUDGET) {
        fail(`a block entity is no longer the component ABI: ${JSON.stringify(caps)}`);
      }

      const refusal = refusalOf(test, counters.where(block), 'coalesce on a block');

      if (refusal === undefined) {
        failed = true;
      } else if (!refusal.startsWith('coalesce:')) {
        fail(`coalesce on a block was refused for the wrong reason: ${refusal}`);
      }

      // Just under the budget: what the engine still accepts on one block per pack.
      probes.for(block).set({ hits: 1, note: 'n'.repeat(COMPONENT_BUDGET - 80) });

      let budgetError: unknown;

      try {
        probes.for(block).set({ hits: 2, note: 'n'.repeat(COMPONENT_BUDGET) });
      } catch (error) {
        budgetError = error;
      }

      if (!(budgetError instanceof DbBudgetError)) { fail(`an oversized block document threw ${String(budgetError)}, expected DbBudgetError`); }
    })
    .thenIdle(4)
    .thenExecute(() => {
      if (failed) { return; }

      probes.forget(test.getBlock(at));

      // A fresh handle from the engine reads what the last handle wrote, and nothing the refused
      // write would have left behind.
      const doc = probes.for(test.getBlock(at)).get();

      if (doc?.hits !== 1 || doc.note.length !== COMPONENT_BUDGET - 80) { fail(`the block document read back ${JSON.stringify({ hits: doc?.hits, note: doc?.note.length })}`); }

      const indexed = [...probes.all()];
      const location = test.getBlock(at).location;

      if (indexed.length !== 1) {
        fail(`the index holds ${indexed.length} entries, expected 1`);

        return;
      }

      const entry = indexed[0];

      if (entry?.kind !== 'block' || entry.identity !== `${test.getDimension().id}:${location.x},${location.y},${location.z}:${PROBE_BLOCK}`) {
        fail(`the index entry is ${String(entry?.identity)}`);
      }

      // `setPermutation` is one of the removals S4 measured `onBreak` firing for; the structure
      // helpers place blocks without running block events at all.
      test.getBlock(at).setPermutation(air);
    })
    // `onBreak` runs a tick after the removal, so the index heals on the next tick, never in the
    // call that removed the block.
    .thenIdle(6)
    .thenExecute(() => {
      if (failed) { return; }

      if (probes.size !== 0) { fail(`the index kept ${probes.size} entries after the block was removed`); }

      const refusal = refusalOf(test, probes.where(test.getBlock(at)), 'air');

      if (refusal === undefined) {
        failed = true;
      } else if (!refusal.includes('not accepted')) {
        fail(`air was refused for the wrong reason: ${refusal}`);
      }

      test.setBlockType(PROBE_BLOCK, at);
    })
    .thenIdle(4)
    .thenExecute(() => {
      if (failed) { return; }

      probes.forget(test.getBlock(at));

      const reborn = probes.for(test.getBlock(at)).get();

      if (reborn !== undefined) { fail(`a re-placed block inherited a document: ${JSON.stringify(reborn)}`); }

      test.getBlock(at).setPermutation(air);
    })
    .thenIdle(6)
    .thenSucceed();
});

// Why `ItemStack` is refused and a slot is offered instead: the stack a script holds is a copy,
// a stackable item throws on write, and only the live slot of a non-stackable item keeps bytes.
gametest('db_slots_and_stacks', (test) => {
  const marks = core.db.collection('t_slots', {
    schema: schema<{ owner: string }>({ defaults: { owner: '' } }),
    accept: slots(),
  });
  const at = { x: 1, y: 1, z: 1 };

  test.startSequence()
    .thenExecute(() => { test.setBlockType('minecraft:chest', at); })
    .thenIdle(4)
    .thenExecute(() => {
      const container = test.getBlock(at).getComponent('minecraft:inventory')?.container;

      if (container === undefined) {
        test.fail('the chest has no container');

        return;
      }

      container.setItem(0, new ItemStack('minecraft:diamond_sword', 1));
      container.setItem(1, new ItemStack('minecraft:stone', 4));

      // The resolver refuses an ItemStack by name, whatever its methods say.
      const stack = core.db.resolver.resolve(new ItemStack('minecraft:stone', 1));

      if (stack.ok || !stack.reason.includes('detached copy')) { test.fail(`an ItemStack resolved to ${JSON.stringify(stack)}`); }

      // And that is not pedantry: a write to a non-stackable copy is lost.
      const copy = container.getItem(0);

      copy?.setDynamicProperty('core_fixture:probe', 'lost');

      if (container.getItem(0)?.getDynamicProperty('core_fixture:probe') !== undefined) {
        test.fail('a write to a detached ItemStack reached the world — the refusal is no longer needed');
      }

      // A stackable item cannot hold properties at all, so the slot holding one is refused.
      const stackable = refusalOf(test, marks.where(container.getSlot(1)), 'a stackable slot');

      if (stackable !== undefined && !stackable.includes('stackable')) { test.fail(`a stackable slot was refused for the wrong reason: ${stackable}`); }

      const empty = refusalOf(test, marks.where(container.getSlot(2)), 'an empty slot');

      if (empty !== undefined && !empty.includes('empty')) { test.fail(`an empty slot was refused for the wrong reason: ${empty}`); }

      const caps = capsOf(test, marks.where(container.getSlot(0)), 'a non-stackable slot');

      if (caps !== undefined && (!caps.own || caps.readableWhenUnloaded)) { test.fail(`a slot's capabilities are ${JSON.stringify(caps)}`); }

      marks.for(container.getSlot(0)).set({ owner: 'fixture' });
    })
    .thenIdle(4)
    .thenExecute(() => {
      const container = test.getBlock(at).getComponent('minecraft:inventory')?.container;

      if (container === undefined) {
        test.fail('the chest lost its container');

        return;
      }

      // A slot has no identity, so nothing is cached: this read goes to the item's NBT.
      const kept = marks.for(container.getSlot(0)).get();

      if (kept?.owner !== 'fixture') { test.fail(`a slot document read back ${JSON.stringify(kept)}`); }

      container.setItem(0, undefined);
      test.setBlockType('minecraft:air', at);
    })
    .thenSucceed();
});

// Write-behind: a coalesced document is in memory the moment it is patched and on the target
// after one flush, written once however many times it changed.
gametest('db_coalesce_flush', (test) => {
  const counters = core.db.collection('t_coalesce', {
    schema: schema<{ n: number }>({ defaults: { n: 0 } }),
    accept: entityTypes('minecraft:armor_stand'),
    coalesce: true,
  });
  const stand = test.spawn('minecraft:armor_stand', { x: 1, y: 1, z: 1 });
  // What the collection writes under, once it writes: `resolve.ts` builds this key.
  const key = `core-db:${core.namespace}:entity::t_coalesce:doc`;

  test.startSequence()
    .thenIdle(5)
    .thenExecute(() => {
      const doc = counters.for(stand);

      for (let i = 1; i <= 50; i++) { doc.patch({ n: i }); }

      if (doc.get()?.n !== 50) { test.fail(`the in-memory document reads ${String(doc.get()?.n)} before the flush`); }

      if (stand.getDynamicProperty(key) !== undefined) { test.fail('a coalesced patch wrote through — nothing should reach the entity before the flush'); }
    })
    .thenIdle(5)
    .thenExecute(() => {
      const raw = stand.getDynamicProperty(key);

      if (typeof raw !== 'string') {
        test.fail(`the flush wrote ${String(raw)}`);

        return;
      }

      const parsed: unknown = JSON.parse(raw);
      const stored = typeof parsed === 'object' && parsed !== null && 'd' in parsed ? parsed.d : undefined;

      if (JSON.stringify(stored) !== JSON.stringify({ n: 50 })) { test.fail(`the flush stored ${JSON.stringify(stored)}`); }

      counters.for(stand).delete();
      core.db.flush();
    })
    .thenIdle(5)
    .thenExecute(() => {
      if (stand.getDynamicProperty(key) !== undefined) { test.fail('the delete did not reach the entity'); }
    })
    .thenSucceed();
});
