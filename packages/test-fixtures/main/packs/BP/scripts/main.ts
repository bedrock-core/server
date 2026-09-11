/**
 * The fixture registers with the runtime and does nothing else. The GameTests in
 * `./tests` build their own runtimes; this registration exists so `core` is live for
 * the tests that read it, and so the peer pack has a realm to be discovered from.
 */
import { core } from '@bedrock-core/server-runtime';
import { manifest } from './addon';

core.register({ manifest });
