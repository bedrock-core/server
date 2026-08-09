/**
 * Minimal semver comparison, enough for the runtime versions addons announce.
 *
 * Bedrock script bundles can't pull in a semver library, and the only versions compared here
 * are the ones this package publishes, so the parser only needs `major.minor.patch` with an
 * optional `-prerelease` tail. Anything unparseable sorts as `0.0.0` rather than throwing —
 * a peer with a malformed version loses the host election instead of breaking it.
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;

  /** Dot-separated prerelease identifiers, empty for a release build. */
  prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9a-z.-]+))?/i;

function parse(version: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(version.trim());

  if (!match) { return { major: 0, minor: 0, patch: 0, prerelease: [] }; }

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Compare two prerelease tails per semver: a release (empty tail) outranks any prerelease,
 * numeric identifiers compare numerically, and a longer tail wins an otherwise-equal prefix.
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) { return 0; }

  if (a.length === 0) { return 1; }

  if (b.length === 0) { return -1; }

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];

    if (left === right) { continue; }

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);

    if (leftNumeric && rightNumeric) { return Number(left) < Number(right) ? -1 : 1; }

    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) { return leftNumeric ? -1 : 1; }

    return left < right ? -1 : 1;
  }

  if (a.length === b.length) { return 0; }

  return a.length < b.length ? -1 : 1;
}

/**
 * Compare two version strings: `-1` when `a` is older, `1` when newer, `0` when equal.
 * Suitable for `Array.prototype.sort`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);

  if (left.major !== right.major) { return left.major < right.major ? -1 : 1; }

  if (left.minor !== right.minor) { return left.minor < right.minor ? -1 : 1; }

  if (left.patch !== right.patch) { return left.patch < right.patch ? -1 : 1; }

  return comparePrerelease(left.prerelease, right.prerelease);
}
