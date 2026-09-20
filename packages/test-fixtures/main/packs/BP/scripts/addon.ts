/**
 * What the fixture says about itself. Display fields are plain text rather than
 * translation keys: the fixture ships no .lang, and Bedrock falls back to the
 * literal string when no key matches.
 */
export const manifest = {
  creator: 'core',
  pack: 'fixture',
  packName: 'Bedrock Core fixture',
  creatorName: 'Bedrock Core',
  version: '1.0.0',
  description: 'GameTest fixture for the Bedrock Core server runtime',
} as const;
