/**
 * The peer pack's identity. It exists only so that `cross_pack_peer_present` can
 * assert one real pack discovers another across pack boundaries — the one case the
 * single-realm tests cannot cover.
 */
export const manifest = {
  creator: 'core',
  pack: 'fixture_peer',
  packName: 'Bedrock Core fixture peer',
  creatorName: 'Bedrock Core',
  version: '1.0.0',
  description: 'Second pack for the cross-pack discovery test',
} as const;
