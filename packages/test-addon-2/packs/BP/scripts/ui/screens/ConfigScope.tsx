import { Fragment, Panel, Text, useContext, type JSX } from '@bedrock-core/ui-runtime';
import { Button, Card, Divider, theme } from '@bedrock-core/ore-styled';
import { CoreContext } from '../CoreContext';
import { filterScope, getScopedSchema, splitScalarsAndLists, type ConfigScope as Scope } from '../configUtils';
import type { AppScreen } from '../routes';

const { spacing, fontColor } = theme.tokens;

const SCOPES: { scope: Scope; label: string; hint: string }[] = [
  { scope: 'server', label: 'Server', hint: 'World-wide settings' },
  { scope: 'dimension', label: 'Dimension', hint: 'Per-dimension settings' },
  { scope: 'player', label: 'Player', hint: 'Per-player settings' },
];

/**
 * Scope picker for one addon. Each scope's scalar fields open as a single native
 * modal form (`Config`); a modal cannot hold regular buttons, so each list field
 * gets its own entry here instead, opening the `ConfigList` editor.
 */
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

  return (
    <Card flexDirection={'column'} padding={12} gap={spacing.sm}>
      <Text font={'minecraftTen'} scale={1.5}>{addonName}</Text>
      <Divider />
      <Panel flexDirection={'column'} gap={spacing.xs}>
        {SCOPES.map(({ scope, label, hint }, index) => {
          const { scalars, lists } = splitScalarsAndLists(filterScope(schema, scope));
          const hasScalars = Object.keys(scalars).length > 0;

          if (!hasScalars && Object.keys(lists).length === 0) { return <Fragment />; }

          return (
            <Fragment>
              {hasScalars
                ? (
                    <Button
                      variant={index === 0 ? 'primary' : 'secondary'}
                      onPress={(): void => navigation.navigate('Config', {
                        addonId,
                        scope,
                        breadcrumb: `${addonName} > ${label}`,
                      })}
                    >
                      {`${label}\n${hint}`}
                    </Button>
                  )
                : null}
              <Fragment>
                {Object.entries(lists).map(([fieldKey, entry]) => (
                  <Button
                    variant={'secondary'}
                    onPress={(): void => navigation.navigate('ConfigList', {
                      addonId,
                      scope,
                      fieldKey,
                      breadcrumb: `${addonName} > ${label} > ${entry.label}`,
                    })}
                  >
                    {`${entry.label}\n${fontColor.muted}${label} list`}
                  </Button>
                ))}
              </Fragment>
            </Fragment>
          );
        })}
      </Panel>
      <Divider />
      <Button variant={'contrast'} onPress={(): void => navigation.goBack()}>{'Back'}</Button>
    </Card>
  );
}
