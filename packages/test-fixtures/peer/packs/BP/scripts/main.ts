/**
 * Publishes local translations and serves cross-pack fixture calls. The main pack verifies
 * discovery, built-in publication, structured values and requests split across wire messages.
 */
import { core } from '@bedrock-core/server-runtime';
import { createI18n, createResourceBundle } from '@bedrock-core/i18n';
import { PEER_ECHO_MODULE, peerEchoShape, type StructuredPayload } from './contract';
import manifest from '../manifest.json';

createI18n(createResourceBundle('core_fixture_peer', { en_US: { builtin: 'published without a translation reader' } }));
core.register({ manifest });

/** The same checksum the caller computes, over what this realm reassembled. */
function checksum(value: unknown): number {
  const json = JSON.stringify(value);
  let sum = 0;

  for (let i = 0; i < json.length; i++) { sum = (sum * 31 + json.charCodeAt(i)) % 2_147_483_647; }

  return sum;
}

core.api.provideModule(PEER_ECHO_MODULE, peerEchoShape, {
  echo: async (value: unknown): Promise<{ chars: number; sum: number }> => ({ chars: JSON.stringify(value).length, sum: checksum(value) }),
  structured: async (value: StructuredPayload): Promise<StructuredPayload> => value,
});
