import { createEngineDb } from '@bedrock-core/db/minecraft';
import manifest from '../manifest.json';

/** Shared with the fixture's block cleanup component. */
export const database = createEngineDb(manifest.namespace);
