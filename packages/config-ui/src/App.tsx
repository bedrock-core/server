import { TranslationKeysContext, type JSX } from '@bedrock-core/ui-runtime';
import { createStackNavigator, NavigationContainer, type NavigationState } from '@bedrock-core/navigation';
import type { Runtime } from '@bedrock-core/server-runtime';
import { CoreContext } from './CoreContext';
import type { AppRoutes, ConfigScope } from './routes';
import { List } from './screens/List';
import { ConfigScope as ConfigScopeScreen } from './screens/ConfigScope';
import { Config } from './screens/Config';
import { ConfigList } from './screens/ConfigList';

const Stack = createStackNavigator<AppRoutes>({
  initialRouteName: 'List',
  screens: {
    List,
    ConfigScope: ConfigScopeScreen,
    Config,
    ConfigList,
  },
});

export interface AppProps {
  core: Runtime;
  addonId?: string;
  scope?: ConfigScope;
  entityId?: string;
}

function buildInitialState(addonId: string, scope?: ConfigScope, entityId?: string): Partial<NavigationState> {
  if (scope) {
    const scopeLabel = `${scope.charAt(0).toUpperCase()}${scope.slice(1)}`;

    return {
      routes: [
        { key: 'List', name: 'List' },
        { key: 'ConfigScope', name: 'ConfigScope', params: { addonId } },
        { key: 'Config', name: 'Config', params: { addonId, scope, entityId, breadcrumb: `${addonId} > ${scopeLabel}` } },
      ],
      index: 2,
    };
  }

  return {
    routes: [
      { key: 'List', name: 'List' },
      { key: 'ConfigScope', name: 'ConfigScope', params: { addonId } },
    ],
    index: 1,
  };
}

export function App({ core, addonId, scope, entityId }: AppProps): JSX.Element {
  return (
    <CoreContext value={core}>
      {/* Merged map: local vanilla + own keys, overlaid with every peer addon's published
          keys (core.translations) — so cross-addon registry fields measure correctly. */}
      <TranslationKeysContext value={core.translations.all()}>
        <NavigationContainer initialState={addonId ? buildInitialState(addonId, scope, entityId) : undefined}>
          <Stack.Navigator />
        </NavigationContainer>
      </TranslationKeysContext>
    </CoreContext>
  );
}
