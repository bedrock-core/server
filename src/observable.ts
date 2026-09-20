/**
 * `@bedrock-core/server/observable` — the reactive primitive the stack notifies through.
 *
 * Re-exports `@bedrock-core/observable` and its Minecraft bridge. Every config leaf, shared key and
 * db document already *is* one of these, so `observable`, `computed`, `effect`, `batch` and `last`
 * compose with them directly, and `toNative` hands one to a data-driven form:
 *
 * ```ts
 * import { computed, last, toNative } from '@bedrock-core/server/observable';
 *
 * const total = computed(() => shared.price.get() * shared.stock.get(), [shared.price, shared.stock]);
 * const lastJoin = last(world.afterEvents.playerSpawn);
 *
 * const { native: volume, dispose } = toNative(config.player.for(p).volume, { clientWritable: true });
 * new CustomForm(p, 'Settings').slider('Volume', volume, 0, 100).show().then(dispose);
 * ```
 *
 * The bridge is the only part that imports `@minecraft/server-ui`, so this subpath carries it as an
 * optional peer dependency: a pack that reaches for `toNative` declares the module in its manifest.
 */
export * from '@bedrock-core/observable';
export * from '@bedrock-core/observable/minecraft';
