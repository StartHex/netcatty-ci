import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORK_RELEASES_API_URL,
  FORK_REPO_URL,
  compareForkVersions,
  parseForkVersion,
  pickLatestForkRelease,
} from './forkRelease.ts';

test('fork versions are <upstream>-fork.<n>', () => {
  assert.deepEqual(parseForkVersion('1.1.90-fork.57'), { upstream: [1, 1, 90], build: 57 });
  assert.deepEqual(parseForkVersion('v1.2.0-fork.3'), { upstream: [1, 2, 0], build: 3 });
  for (const other of ['1.1.90', '0.0.0-fork-36f32b9', 'fork-macos-latest', '1.1.90-fork', '1.1.90-beta.1']) {
    assert.equal(parseForkVersion(other), null, other);
  }
});

test('ordering: upstream base first, then the fork build counter', () => {
  assert.equal(compareForkVersions('1.1.90-fork.58', '1.1.90-fork.57'), 1);
  assert.equal(compareForkVersions('1.1.90-fork.9', '1.1.90-fork.10'), -1, 'numeric, not lexical');
  assert.equal(compareForkVersions('1.1.91-fork.60', '1.1.90-fork.99'), 1, 'a newer upstream base wins');
  assert.equal(compareForkVersions('1.2.0-fork.1', '1.1.99-fork.500'), 1);
  assert.equal(compareForkVersions('v1.1.90-fork.57', '1.1.90-fork.57'), 0);
});

test('installs without a fork counter are offered the first fork release', () => {
  // Packages built before versioned releases existed, and development builds.
  assert.equal(compareForkVersions('1.1.90-fork.1', '0.0.0-fork-36f32b9'), 1);
  assert.equal(compareForkVersions('1.1.90-fork.1', '0.0.0'), 1);
  // A plain upstream version of the same base is older than any fork build of it.
  assert.equal(compareForkVersions('1.1.90-fork.1', '1.1.90'), 1);
  assert.equal(compareForkVersions('1.1.90', '1.1.90-fork.1'), -1);
});

test('only versioned, published fork releases are update candidates', () => {
  const releases = [
    { tag_name: 'fork-windows-x64-latest', prerelease: true },
    { tag_name: 'v1.1.90-fork.57' },
    { tag_name: 'v1.1.90-fork.61', draft: true },
    { tag_name: 'v1.1.90-fork.60', prerelease: true },
    { tag_name: 'v1.1.90-fork.59' },
    { tag_name: 'v1.1.91' },
    { tag_name: 'nightly' },
    { tag_name: 42 },
  ];
  assert.equal(pickLatestForkRelease(releases)?.tag_name, 'v1.1.90-fork.59');
  assert.equal(pickLatestForkRelease([{ tag_name: 'fork-macos-latest', prerelease: true }]), null);
  assert.equal(pickLatestForkRelease([]), null);
});

test('update checks never point at the upstream repository', () => {
  assert.equal(FORK_REPO_URL, 'https://github.com/StartHex/netcatty-ci');
  assert.match(FORK_RELEASES_API_URL, /^https:\/\/api\.github\.com\/repos\/StartHex\/netcatty-ci\/releases/);
});
