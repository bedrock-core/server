import { world } from '@minecraft/server';
import { createContainerScreen } from '@bedrock-core/ui/container';
import CraftingTable from '../screens/crafting_table.screen';

/**
 * Serving the Shop's compiled screen. The screen module describes itself; the
 * build compiled the same module into JSON UI, and the runtime runs it again
 * per viewer for the live values.
 */
const screen = createContainerScreen(CraftingTable);

/**
 * Nothing opens a container from script, so the screen is bound to something
 * in the world: placing a vanilla crafting table puts the Shop's own on top of
 * it, one per world, and interacting with that entity opens the screen.
 */
export const setupCrafting = (): void => {
  world.afterEvents.playerPlaceBlock.subscribe(({ block }) => {
    if (block.typeId !== 'minecraft:crafting_table') {
      return;
    }

    const { dimension } = block;

    for (const existing of dimension.getEntities({ type: screen.entity })) {
      existing.remove();
    }

    dimension.spawnEntity(screen.entity, {
      x: block.x + 0.5,
      y: block.y + 1,
      z: block.z + 0.5,
    });
  });
};
