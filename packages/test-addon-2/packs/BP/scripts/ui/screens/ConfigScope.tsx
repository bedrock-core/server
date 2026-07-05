import { Panel, Text, useContext, type JSX } from '@bedrock-core/ui-runtime';
import { Button, Card, Divider, theme } from '@bedrock-core/ore-styled';
import { CoreContext } from '../CoreContext';
import { filterScope, getScopedSchema } from '../configUtils';
import type { AppScreen } from '../routes';

const { spacing } = theme.tokens;

export function ConfigScope({ navigation, route }: AppScreen<'ConfigScope'>): JSX.Element {
  const core = useContext(CoreContext)!;
  const { addonId } = route.params;
  const accessor = core.config.of(addonId);

  if (!accessor) {
    return (
      <Card flexDirection={'column'} padding={12} gap={spacing.sm}>
        <Text>{'No published config for this addon.'}</Text>
        <Button onPress={(): void => navigation.goBack()}>{'Back'}</Button>
      </Card>
    );
  }

  const addonName = core.registry.get(addonId)?.name ?? addonId;
  const schema = getScopedSchema(accessor);

  const hasServer = Object.keys(filterScope(schema, 'server')).length > 0;
  const hasDimension = Object.keys(filterScope(schema, 'dimension')).length > 0;
  const hasPlayer = Object.keys(filterScope(schema, 'player')).length > 0;

  return (
    <Card flexDirection={'column'} padding={12} gap={spacing.sm}>
      <Text font={'minecraftTen'} scale={1.5}>{addonName}</Text>
      <Divider />
      <Panel flexDirection={'column'} gap={spacing.xs}>
        {hasServer ? (
          <Button onPress={(): void => navigation.navigate('Config', {
            addonId,
            scope: 'server',
            breadcrumb: `${addonName} > Server`,
          })}>
            {'Server\nWorld-wide settings'}
          </Button>
        ) : null}
        {hasDimension ? (
          <Button variant={'secondary'} onPress={(): void => navigation.navigate('Config', {
            addonId,
            scope: 'dimension',
            breadcrumb: `${addonName} > Dimension`,
          })}>
            {'Dimension\nPer-dimension settings'}
          </Button>
        ) : null}
        {hasPlayer ? (
          <Button variant={'secondary'} onPress={(): void => navigation.navigate('Config', {
            addonId,
            scope: 'player',
            breadcrumb: `${addonName} > Player`,
          })}>
            {'Player\nPer-player settings'}
          </Button>
        ) : null}
      </Panel>
      <Divider />
      <Button variant={'contrast'} onPress={(): void => navigation.goBack()}>{'Back'}</Button>
    </Card>
  );
}
