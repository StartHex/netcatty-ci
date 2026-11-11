/**
 * Where this build's releases live.
 *
 * This is a fork of binaricat/Netcatty with its own modules, so update checks,
 * download links and "report an issue" links must point at the fork: following
 * upstream's releases would replace the app with a build that lacks them.
 *
 * Fork versions are `<upstream version>-fork.<n>` (e.g. `1.1.90-fork.57`):
 * the upstream release the code is based on (fork-version.json, bumped when
 * upstream is merged) plus a counter that grows with every packaged build.
 */
export const FORK_REPO_OWNER = 'StartHex';
export const FORK_REPO_NAME = 'netcatty-ci';
export const FORK_REPO_URL = `https://github.com/${FORK_REPO_OWNER}/${FORK_REPO_NAME}`;
export const FORK_RELEASES_URL = `${FORK_REPO_URL}/releases`;
export const FORK_RELEASES_API_URL =
  `https://api.github.com/repos/${FORK_REPO_OWNER}/${FORK_REPO_NAME}/releases?per_page=30`;

/** Release tags that are app versions: `v1.1.90-fork.57`. */
const FORK_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)-fork\.(\d+)$/;

export interface ForkVersion {
  upstream: [number, number, number];
  build: number;
}

/** Parses `1.1.90-fork.57` / `v1.1.90-fork.57`; null for anything else. */
export function parseForkVersion(version: string): ForkVersion | null {
  const match = FORK_VERSION_RE.exec(version.trim());
  if (!match) return null;
  return {
    upstream: [Number(match[1]), Number(match[2]), Number(match[3])],
    build: Number(match[4]),
  };
}

function leadingNumbers(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => {
      const value = parseInt(part, 10);
      return Number.isNaN(value) ? 0 : value;
    });
}

/**
 * Orders versions for the update check: 1 if a is newer, -1 if older, 0 if equal.
 *
 * Upstream base first, then the fork build counter. A version without a fork
 * counter (a development build, an old `0.0.0-fork-<sha>` package, a plain
 * upstream version) sorts before every fork build of the same base, so those
 * installs are offered the first versioned fork release.
 */
export function compareForkVersions(a: string, b: string): number {
  const forkA = parseForkVersion(a);
  const forkB = parseForkVersion(b);
  const baseA = forkA?.upstream ?? leadingNumbers(a);
  const baseB = forkB?.upstream ?? leadingNumbers(b);
  for (let index = 0; index < 3; index += 1) {
    const left = baseA[index] ?? 0;
    const right = baseB[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  const buildA = forkA?.build ?? -1;
  const buildB = forkB?.build ?? -1;
  if (buildA === buildB) return 0;
  return buildA > buildB ? 1 : -1;
}

interface GitHubReleaseLike {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * Newest app release in a GitHub release list. Only `v<x.y.z>-fork.<n>` tags
 * count: drafts, prereleases and the rolling `fork-*-latest` test-build tags
 * are never offered as updates.
 */
export function pickLatestForkRelease<T extends GitHubReleaseLike>(releases: readonly T[]): T | null {
  let best: T | null = null;
  for (const release of releases) {
    if (!release || release.draft === true || release.prerelease === true) continue;
    if (typeof release.tag_name !== 'string' || !parseForkVersion(release.tag_name)) continue;
    if (!best || compareForkVersions(release.tag_name, best.tag_name as string) > 0) best = release;
  }
  return best;
}
