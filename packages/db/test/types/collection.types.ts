/**
 * Compile-time assertions for the collection API: the acceptor brands `for()`, and `require` is
 * checked against what the target type can possibly do. Compiled by `yarn test:types`, never run.
 */
import type { Block, Dimension, Entity, ItemStack, Player, World } from '@minecraft/server';
import { accepting, allOf, anyOf, blockTypes, dimensions, entityTypes, except, players, schema, slots, worldTarget, type Db } from '../../src/index';

declare const db: Db;
declare const block: Block;
declare const player: Player;
declare const entity: Entity;
declare const dimension: Dimension;
declare const world: World;
declare const stack: ItemStack;

interface Doc {
  n: number;
}

// The acceptor fixes the target type; the document type rides the schema.
const elevators = db.collection('elevators', { schema: schema<Doc>({ version: 2 }), accept: blockTypes('papi:elevator') });

elevators.for(block);
// @ts-expect-error a block collection takes no player
elevators.for(player);

const balances = db.collection('balances', { schema: schema<Doc>(), accept: players() });

balances.for(player);
// @ts-expect-error a player collection takes no plain entity
balances.for(entity);

// No acceptor: anything storable, never an ItemStack.
const loose = db.collection('loose', { schema: schema<Doc>({ version: 2, defaults: { n: 0 } }) });

// @ts-expect-error the schema names the document type; there is no other place for it
db.collection('untyped', { accept: blockTypes() });
// @ts-expect-error an explicit type argument switches inference off, so the acceptor cannot type the target
db.collection<Doc>('mixed', { schema: schema<Doc>(), accept: blockTypes() });

loose.for(block);
loose.for(player);
loose.for(world);
loose.for(dimension);
// @ts-expect-error an ItemStack is a detached copy
loose.for(stack);

// Requirements the type can always satisfy compile.
db.collection('a', { schema: schema<Doc>(), accept: worldTarget(), require: { own: true } });
db.collection('b', { schema: schema<Doc>(), accept: entityTypes('ns:mob'), require: { own: true, enumerable: true } });
db.collection('c', { schema: schema<Doc>(), accept: dimensions(), require: { readableWhenUnloaded: true } });

// Requirements only the instance can satisfy compile too; the resolver refuses at runtime.
db.collection('d', { schema: schema<Doc>(), accept: blockTypes(), require: { own: true } });
db.collection('e', { schema: schema<Doc>(), accept: slots(), require: { own: true } });

// Requirements the type can never satisfy do not compile.
// @ts-expect-error a dimension never holds its own properties
db.collection('f', { schema: schema<Doc>(), accept: dimensions(), require: { own: true } });
// @ts-expect-error an entity is unreachable while unloaded
db.collection('g', { schema: schema<Doc>(), accept: entityTypes(), require: { readableWhenUnloaded: true } });
// @ts-expect-error own and readableWhenUnloaded exclude each other
db.collection('h', { schema: schema<Doc>(), accept: blockTypes(), require: { own: true, readableWhenUnloaded: true } });

// The escape hatch carries the caller's type.
const custom = db.collection('i', { schema: schema<Doc>(), accept: accepting<Block>(id => id.startsWith('ns:')) });

custom.for(block);
// @ts-expect-error typed by the caller as Block
custom.for(player);

// Composition: anyOf is the union, allOf the intersection, except keeps the base type.
const mixed = db.collection('j', { schema: schema<Doc>(), accept: anyOf(players(), blockTypes('papi:elevator')) });

mixed.for(player);
mixed.for(block);
// @ts-expect-error neither a player nor a block
mixed.for(dimension);

const namespaced = db.collection('k', { schema: schema<Doc>(), accept: allOf(entityTypes(), accepting<Entity>(id => id.startsWith('papi:'))) });

namespaced.for(entity);
namespaced.for(player);
// @ts-expect-error an entity collection takes no block
namespaced.for(block);

const mobs = db.collection('l', { schema: schema<Doc>(), accept: except(entityTypes(), players()) });

mobs.for(entity);
mobs.for(player); // compiles: the exclusion is a runtime refusal, TypeScript cannot subtract a subclass
// @ts-expect-error still an entity collection
mobs.for(block);

const nested = db.collection('o', { schema: schema<Doc>(), accept: anyOf(except(entityTypes(), players()), allOf(blockTypes(), accepting<Block>(id => id.startsWith('papi:')))) });

nested.for(entity);
nested.for(block);
// @ts-expect-error not in the union
nested.for(world);

// Composition keeps the require check: a dimension in the union can still never be own... but a
// block can, so the union is `boolean` and compiles; a pure dimension composition does not.
db.collection('m', { schema: schema<Doc>(), accept: anyOf(dimensions(), blockTypes()), require: { own: true } });
// @ts-expect-error every member of the union is statically not own
db.collection('n', { schema: schema<Doc>(), accept: anyOf(dimensions('minecraft:nether'), dimensions('minecraft:the_end')), require: { own: true } });

// Documents are typed.
const doc = elevators.for(block).get();

if (doc) {
  const n: number = doc.n;

  void n;
}

// @ts-expect-error wrong shape
elevators.for(block).set({ m: 1 });
// @ts-expect-error wrong shape
elevators.for(block).patch({ n: 'x' });
