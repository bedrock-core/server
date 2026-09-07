import { type Container as ItemContainer, type Entity, EntityComponentTypes, ItemStack } from '@minecraft/server';
import { Button, Card } from '@bedrock-core/ore-styled';
import type { JSX } from '@bedrock-core/ui';
import { GUARD_ITEM } from '@bedrock-core/ui/container';
import {
  Container,
  Hotbar,
  Panel,
  PlayerInventory,
  Slot,
  Text,
  useExit,
  useState,
} from '@bedrock-core/ui';

/**
 * Container slots the screen draws, in tree order: the sentinel takes 0 and
 * 1, the nine inputs follow it row by row, the craft button takes 11 — a
 * button is a drawn cell too — and the output is 12. Handlers reach the
 * result slot by this index, since machinery fills an output by writing over
 * its guard.
 */
const INPUTS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const OUTPUT = 12;

/** Four planks anywhere on the grid make a table; the recipe is the point, not the crafting. */
const PLANKS = 'minecraft:oak_planks';
const RESULT = 'minecraft:crafting_table';
const COST = 4;

/**
 * The Shop's crafting table: a second compiled screen from a second addon, so
 * a world carrying the ui demo pack's furnace and this table exercises two
 * addons' routers on the one chest root.
 */
export default function CraftingTable(): JSX.Element {
  const [planks, setPlanks] = useState(0);
  const [crafted, setCrafted] = useState(0);
  const exit = useExit();

  return (
    <Container
      entity={'drav0011_shop:crafting_table'}
      flexDirection={'column'}
      padding={8}
      gap={6}
      background={'textures/ui/dialog_background_opaque'}
      onOpen={({ host }) => setPlanks(countPlanks(host))}
    >
      <Card width={'100%'}>
        <Panel flexDirection={'row'} gap={4} alignItems={'center'}>
          <Text>{'§fSHOP CRAFTING'}</Text>
          <Panel flexGrow={1} />
          <Text maxLength={12}>{`planks ${planks}`}</Text>
        </Panel>

        <Panel flexDirection={'row'} gap={8} alignItems={'center'} marginTop={4}>
          {/* Nine inputs, row by row: planks go in, and only a craft takes them out. */}
          <Panel flexDirection={'column'} gap={0}>
            {[0, 1, 2].map(() => (
              <Panel flexDirection={'row'} gap={0}>
                {[0, 1, 2].map(() => (
                  <Panel background={'textures/ui/slot_enabled'} flexShrink={0}>
                    <Slot
                      role={'both'}
                      onInsert={({ host }) => setPlanks(countPlanks(host))}
                      onRemove={({ host }) => setPlanks(countPlanks(host))}
                    />
                  </Panel>
                ))}
              </Panel>
            ))}
          </Panel>

          <Button
            enabled={planks >= COST}
            onPress={({ host }) => {
              if (host !== undefined && craft(host)) {
                setCrafted(value => value + 1);
                setPlanks(countPlanks(host));
              }
            }}
          >
            {'craft'}
          </Button>

          {/* The result: taken out, never put in. */}
          <Panel background={'textures/ui/slot_enabled'} flexShrink={0}>
            <Slot role={'output'} onRemove={() => setCrafted(0)} />
          </Panel>

          <Text maxLength={10}>{`made ${crafted}`}</Text>
        </Panel>

        <Button
          variant={'transparent'}
          width={14}
          height={14}
          position={'absolute'}
          top={4}
          right={4}
          background={'textures/ui/close_button_default'}
          backgroundHover={'textures/ui/close_button_hover'}
          backgroundPressed={'textures/ui/close_button_pressed'}
          onPress={exit}
        />
      </Card>

      <Panel flexGrow={1} />

      <PlayerInventory />
      <Hotbar marginTop={4} />
    </Container>
  );
}

const containerOf = (host: Entity): ItemContainer | undefined =>
  host.getComponent(EntityComponentTypes.Inventory)?.container;

/** Planks across the nine inputs. */
const countPlanks = (host: Entity): number => {
  const container = containerOf(host);

  if (container === undefined) {
    return 0;
  }

  let total = 0;

  for (const slot of INPUTS) {
    const stack = container.getItem(slot);

    if (stack?.typeId === PLANKS) {
      total += stack.amount;
    }
  }

  return total;
};

/**
 * Takes four planks off the grid and writes a table over the output's guard.
 * Refused while a result still sits in the output: the machine never
 * overwrites what the player has not taken.
 */
const craft = (host: Entity): boolean => {
  const container = containerOf(host);

  if (container === undefined) {
    return false;
  }

  // An empty output holds the runtime's guard; anything else is a result not yet taken.
  const standing = container.getItem(OUTPUT);

  if (standing !== undefined && standing.typeId !== GUARD_ITEM) {
    return false;
  }

  let owed = COST;

  for (const slot of INPUTS) {
    const stack = container.getItem(slot);

    if (owed === 0 || stack?.typeId !== PLANKS) {
      continue;
    }

    const taken = Math.min(owed, stack.amount);

    owed -= taken;
    container.setItem(slot, stack.amount > taken ? withAmount(stack, stack.amount - taken) : undefined);
  }

  if (owed > 0) {
    return false;
  }

  container.setItem(OUTPUT, new ItemStack(RESULT, 1));

  return true;
};

const withAmount = (stack: ItemStack, amount: number): ItemStack => {
  const copy = stack.clone();

  copy.amount = amount;

  return copy;
};
