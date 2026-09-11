/**
 * Registers and stops. Everything this pack is for happens in the other pack's test.
 */
import { core } from '@bedrock-core/server-runtime';
import { manifest } from './addon';

core.register({ manifest });
