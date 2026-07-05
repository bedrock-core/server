import { Panel, Scroll, Text, Button, useContext, type JSX } from '@bedrock-core/ui-runtime';
import { Button as OreButton, Card, Divider, theme } from '@bedrock-core/ore-styled';
import { CoreContext } from '../CoreContext';
import type { AppScreen } from '../routes';

const { spacing } = theme.tokens;

const ICON_CLOSE = 'textures/ui/ore-styled/button/close';
const ICON_BACK = 'textures/ui/ore-styled/button/back';

export function List({ navigation }: AppScreen<'List'>): JSX.Element {
  const core = useContext(CoreContext)!;
  const addons = core.registry.all().filter(a => core.config.of(a.id) !== undefined);

  return (
    <Card flexDirection={'column'} padding={0} gap={0}>
      <Panel flexDirection={'row'} alignItems={'center'} padding={spacing.sm} gap={spacing.xs}>
        <Button width={20} height={20} background={ICON_BACK} />
        <Text flexGrow={1} font={'minecraftTen'} scale={1.5}>{'Addons'}</Text>
        <Button width={20} height={20} background={ICON_CLOSE} />
      </Panel>
      <Divider />
      <Panel flexDirection={'row'} flexGrow={1}>
        <Panel width={'33%'}>
          <Scroll>
            <Panel flexDirection={'column'} gap={spacing.xs} padding={spacing.sm}>
              {addons.length === 0
                ? <Text>{'No addons with config registered.'}</Text>
                : addons.map(addon => (
                  <OreButton onPress={(): void => navigation.navigate('ConfigScope', { addonId: addon.id })}>
                    {`${addon.name}  v${addon.version}`}
                  </OreButton>
                ))
              }
            </Panel>
          </Scroll>
        </Panel>
        <Panel flexGrow={1} />
      </Panel>
    </Card>
  );
}
