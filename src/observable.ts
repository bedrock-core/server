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
 * `debounce(source, afterTicks(ticks))` publishes the latest source value after a quiet period
 * measured in Minecraft ticks. The Minecraft adapters import `@minecraft/server` and
 * `@minecraft/server-ui`; a pack using this entry declares both modules in its manifest.
 */
export * from '@bedrock-core/observable';
export * from '@bedrock-core/observable/minecraft';
