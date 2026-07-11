import { Button as OreButton, Card, theme } from '@bedrock-core/ore-styled';
import { Runtime } from '@bedrock-core/server-runtime';
import { Button, Image, Panel, Scroll, Text, useContext, useExit, type JSX } from '@bedrock-core/ui-runtime';
import { CoreContext } from '../CoreContext';
import { buildNestedPatch, filterScope, getRoster, getScopedSchema, patchScope, type FlatSchemaLike } from '../configUtils';
import type { AppScreen } from '../routes';

const { spacing, fontColor } = theme.tokens;

const HEADER_BG = 'textures/ui/ore-styled/header/background';
const ICON_BACK = 'textures/ui/ore-styled/button/back/background';
const ICON_BACK_HOVER = 'textures/ui/ore-styled/button/back/background_hover';
const ICON_BACK_PRESSED = 'textures/ui/ore-styled/button/back/background_pressed';
const ICON_CLOSE = 'textures/ui/ore-styled/button/close/background';
const ICON_CLOSE_HOVER = 'textures/ui/ore-styled/button/close/background_hover';
const ICON_CLOSE_PRESSED = 'textures/ui/ore-styled/button/close/background_pressed';
const ICON_RESET = 'textures/ui/config/reset';

/** Flat patch of every entry's code (schema) default. */
function schemaDefaultsPatch(schema: FlatSchemaLike): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(schema)) { flat[key] = entry.default; }

  return buildNestedPatch(flat);
}

/**
 * Select list for a 'dimension' or 'player' scope: one row per known entity
 * (known dimensions, or currently online players), each with its own edit
 * button (jumps into that entity's settings) and reset button (resets that
 * entity to the addon's code-defined defaults).
 */
export function EntityList({ navigation, route }: AppScreen<'EntityList'>): JSX.Element {
  const core = useContext<Runtime>(CoreContext);
  const exit = useExit();
  const { addonId, scope, breadcrumb } = route.params;
  const accessor = core.config.of(addonId);

  if (!accessor) {
    return (
      <Card flexDirection={'column'} padding={12} gap={spacing.sm}>
        <Text>{'No published config for this addon.'}</Text>
        <Button onPress={(): void => navigation.goBack()}>{'Back'}</Button>
      </Card>
    );
  }

  const configAccessor = accessor;
  const schema = filterScope(getScopedSchema(configAccessor), scope);
  const roster = getRoster(configAccessor, scope);

  const navigateToEntity = (entityId: string, name: string): void => {
    navigation.navigate('Config', { addonId, scope, entityId, breadcrumb: `${breadcrumb} > ${name}` });
  };

  const resetEntity = (entityId: string): void => {
    patchScope(configAccessor, scope, entityId, schemaDefaultsPatch(schema));
  };

  return (
    <Card flexDirection={'column'} padding={0} gap={0}>
      <Panel flexDirection={'row'} alignItems={'center'} justifyContent={'space-between'} padding={spacing.sm} marginTop={1} marginLeft={1} marginRight={1} background={HEADER_BG}>
        <Button width={15} height={15} background={ICON_BACK} backgroundHover={ICON_BACK_HOVER} backgroundPressed={ICON_BACK_PRESSED} onPress={(): void => navigation.goBack()} />
        <Panel position={'absolute'} left={spacing.sm} right={spacing.sm} top={spacing.sm} bottom={spacing.sm} justifyContent={'center'} alignItems={'center'}>
          <Text font={'minecraftTen'} scale={1} offsetY={-2}>{breadcrumb}</Text>
        </Panel>
        <Button width={15} height={15} background={ICON_CLOSE} backgroundHover={ICON_CLOSE_HOVER} backgroundPressed={ICON_CLOSE_PRESSED} onPress={exit} />
      </Panel>
      <Scroll>
        <Panel flexDirection={'column'} gap={spacing.sm} padding={spacing.sm}>
          {roster.length === 0
            ? <Text>{`${fontColor.muted}${scope === 'player' ? 'No players online.' : 'No dimensions found.'}`}</Text>
            : roster.map(entity => (
                <EntityRow
                  label={entity.name}
                  onPress={(): void => navigateToEntity(entity.id, entity.name)}
                  onReset={(): void => resetEntity(entity.id)}
                />
              ))}
        </Panel>
      </Scroll>
    </Card>
  );
}

/** One row: an entity button with a transparent reset-icon button glued to its right. */
function EntityRow({
  label,
  onPress,
  onReset,
}: {
  label: string;
  onPress: () => void;
  onReset: () => void;
}): JSX.Element {
  return (
    <Panel flexDirection={'row'} gap={spacing.xs}>
      <Panel flexGrow={1}>
        <OreButton variant={'primary'} onPress={onPress}>{label}</OreButton>
      </Panel>
      <OreButton variant={'secondary'} paddingLeft={spacing.sm} paddingRight={spacing.sm} paddingTop={spacing.xs} paddingBottom={spacing.xs} onPress={onReset}>
        <Image width={10} height={10} texture={ICON_RESET} marginBottom={spacing.xs} />
      </OreButton>
    </Panel>
  );
}
