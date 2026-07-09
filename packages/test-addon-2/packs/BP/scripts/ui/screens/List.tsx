import { Button as OreButton, Card, Divider, theme } from '@bedrock-core/ore-styled';
import { Button, Image, Panel, Scroll, Text, useContext, useExit, useState, type JSX } from '@bedrock-core/ui-runtime';
import type { RegisteredAddon } from '@bedrock-core/server-runtime';
import { CoreContext } from '../CoreContext';
import type { AppScreen } from '../routes';

const { spacing } = theme.tokens;

const HEADER_BG = 'textures/ui/ore-styled/header/background';
const ICON_CLOSE = 'textures/ui/ore-styled/button/close/background';
const ICON_CLOSE_HOVER = 'textures/ui/ore-styled/button/close/background_hover';
const ICON_CLOSE_PRESSED = 'textures/ui/ore-styled/button/close/background_pressed';
const ICON_MISSING = 'textures/ui/bc_shop/missing_icon';
const ICON_CONFIG = 'textures/ui/config/config';
const ICON_GUIDE = 'textures/ui/config/guide';

// There's no aspect-ratio layout primitive, so the 16:9 height is derived from the
// right panel's actual resolved pixel width instead of guessed: the canonical modal
// viewport is 320px wide (see @bedrock-core/ui-runtime layout tests), the left list
// panel takes 33%, and the vertical Divider is 2px — the remainder is this panel's width.
const VIEWPORT_WIDTH = 320;
const LEFT_PANEL_WIDTH = VIEWPORT_WIDTH * 0.33;
const DIVIDER_WIDTH = 2;
const DETAILS_PANEL_WIDTH = VIEWPORT_WIDTH - LEFT_PANEL_WIDTH - DIVIDER_WIDTH;
const THUMBNAIL_HEIGHT = DETAILS_PANEL_WIDTH * 6 / 16;

export function List({ navigation }: AppScreen<'List'>): JSX.Element {
  const core = useContext(CoreContext)!;
  const addons = core.registry.all().filter(a => core.config.of(a.id) !== undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(addons[0]?.id);
  const selected = addons.find(a => a.id === selectedId);

  const exit = useExit();

  return (
    <Card flexDirection={'column'} padding={0} gap={0}>
      <Panel flexDirection={'row'} alignItems={'center'} justifyContent={'flex-end'} padding={spacing.sm} marginTop={1} marginLeft={1} marginRight={1} background={HEADER_BG}>
        <Panel position={'absolute'} left={spacing.sm} right={spacing.sm} top={spacing.sm} bottom={spacing.sm} justifyContent={'center'} alignItems={'center'}>
          <Text font={'minecraftTen'} scale={1} offsetY={-2}>{'§0Addons'}</Text>
        </Panel>
        <Button width={15} height={15} background={ICON_CLOSE} backgroundHover={ICON_CLOSE_HOVER} backgroundPressed={ICON_CLOSE_PRESSED} onPress={exit} />
      </Panel>
      <Panel flexDirection={'row'} flexGrow={1}>
        <Panel width={'33%'} padding={spacing.sm}>
          <Scroll>
            <Panel flexDirection={'column'}>
              {addons.length === 0
                ? <Text>{'No addons with config registered.'}</Text>
                : addons.map(addon => (
                    <Button
                      padding={spacing.sm}
                      width={'100%'}
                      justifyContent={'flex-start'}
                      onPress={(): void => setSelectedId(addon.id)}
                    >
                      <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.sm}>
                        <Image width={20} height={20} texture={addon.icon ?? ICON_MISSING} />
                        <Panel flexDirection={'column'}>
                          <Text font={'mojangles'} scale={1}>{`§f${addon.name}`}</Text>
                          <Text font={'mojangles'} scale={1}>{`§7${addon.version}`}</Text>
                        </Panel>
                      </Panel>
                    </Button>
                  ))}
            </Panel>
          </Scroll>
        </Panel>
        <Divider orientation={'vertical'} marginBottom={1} />
        <Panel flexGrow={1}>
          {selected ? <AddonDetails addon={selected} navigation={navigation} /> : null}
        </Panel>
      </Panel>
    </Card>
  );
}

function AddonDetails({ addon, navigation }: { addon: RegisteredAddon; navigation: AppScreen<'List'>['navigation'] }): JSX.Element {
  return (
    <Panel flexGrow={1}>
      <Panel position={'absolute'} left={0} right={1} top={0} height={THUMBNAIL_HEIGHT} background={addon.thumbnail} />
      <Panel flexDirection={'column'} flexGrow={1} gap={spacing.md} padding={spacing.md}>
        <Panel justifyContent={'center'} alignItems={'center'}>
          <Image width={40} height={40} texture={addon.icon ?? ICON_MISSING} />
        </Panel>
        <Panel flexDirection={'column'}>
          <Text font={'mojangles'} scale={2} shadow={true}>{`§f${addon.name}`}</Text>
          <Text font={'mojangles'} scale={1}>{`§7Version: ${addon.version}`}</Text>
        </Panel>
        <Panel flexDirection={'row'} gap={spacing.sm}>
          <OreButton variant={'secondary'} paddingTop={2} paddingLeft={4} onPress={(): void => navigation.navigate('ConfigScope', { addonId: addon.id })}>
            <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.sm}>
              <Image width={12} height={12} texture={ICON_CONFIG} />
              <Text font={'mojangles'} scale={1}>{'§0Config'}</Text>
            </Panel>
          </OreButton>
          <OreButton variant={'secondary'} paddingTop={2} paddingLeft={4} enabled={false}>
            <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.sm}>
              <Image width={12} height={12} texture={ICON_GUIDE} />
              <Text font={'mojangles'} scale={1}>{'§8Guide'}</Text>
            </Panel>
          </OreButton>
        </Panel>
        <Card>
          <Text font={'mojangles'} scale={1} wordBreak={'break-word'}>{`§7${addon.description ?? ''}`}</Text>
        </Card>
        <Panel flexDirection={'row'} gap={0}>
          <Text shadow={true}>{'§7Author(s): '}</Text>
          <Text font={'mojangles'} scale={1}>{`§f${addon.creatorName ?? addon.creator}`}</Text>
        </Panel>
      </Panel>
    </Panel>
  );
}
