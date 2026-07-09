import type { ScreenProps } from '@bedrock-core/navigation';
import type { ConfigScope, EntrySchema } from './configUtils';

export type AppRoutes = {
  List: undefined;
  ConfigScope: { addonId: string };
  Config: {
    addonId: string;
    scope: ConfigScope;
    entityId?: string;
    breadcrumb: string;
  };
  ConfigList: {
    addonId: string;
    scope: ConfigScope;
    entityId?: string;
    fieldKey: string;
    breadcrumb: string;
  };
};

export type AppScreen<K extends keyof AppRoutes> = ScreenProps<AppRoutes, K>;

export type { EntrySchema, ConfigScope };
