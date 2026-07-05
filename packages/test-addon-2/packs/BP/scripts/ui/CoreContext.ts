import { createContext } from '@bedrock-core/ui-runtime';
import type { Runtime } from '@bedrock-core/server-runtime';

export const CoreContext = createContext<Runtime | null>(null);
