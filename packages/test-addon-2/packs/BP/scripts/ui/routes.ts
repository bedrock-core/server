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
  ConfigForm: {
    title: string;
    list: string[];
    schema: { itemType?: string; options?: readonly string[]; maxItems?: number };
    onDone: (updated: string[]) => void;
  };
};

export type AppScreen<K extends keyof AppRoutes> = ScreenProps<AppRoutes, K>;

export type { EntrySchema, ConfigScope };
