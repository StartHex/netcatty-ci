#!/usr/bin/env node
"use strict";

// Keeps only the installers of the newest builds on a rolling fork release
// (fork-windows-x64-latest, fork-macos-latest) and deletes the rest, so the
// download page does not bury the current build under dozens of old ones.
//
// usage: node scripts/prune-fork-release-assets.cjs <tag> [keepBuilds=3] [--dry-run]
// Needs the gh CLI with a token that can write releases (GH_TOKEN in CI).

const { execFileSync } = require("node:child_process");

/** `Netcatty-1.1.90-fork.32-win-x64.exe` -> `1.1.90-fork.32`; null when the name is not a build asset. */
function buildKeyOf(assetName) {
  const match = /^Netcatty-(.+?)-(?:win|mac|linux|portable)[-.]/.exec(String(assetName));
  return match ? match[1] : null;
}

/**
 * Splits assets into the ones to keep and the ones to delete. A build is every
 * asset sharing a version; builds are ordered by their newest upload. Assets
 * whose name is not a build asset are always kept.
 */
function planPrune(assets, keepBuilds) {
  const newestByBuild = new Map();
  for (const asset of assets) {
    const key = buildKeyOf(asset.name);
    if (!key) continue;
    const time = Date.parse(asset.updated_at || asset.created_at || "") || 0;
    newestByBuild.set(key, Math.max(newestByBuild.get(key) ?? 0, time));
  }
  const keptBuilds = new Set(
    [...newestByBuild.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
      .slice(0, Math.max(1, keepBuilds))
      .map(([key]) => key),
  );
  const keep = [];
  const remove = [];
  for (const asset of assets) {
    const key = buildKeyOf(asset.name);
    (key && !keptBuilds.has(key) ? remove : keep).push(asset);
  }
  return { keep, remove, keptBuilds: [...keptBuilds] };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const [tag, keepArg] = argv.filter((arg) => !arg.startsWith("--"));
  const keepBuilds = keepArg === undefined ? 3 : Number(keepArg);
  if (!tag || !Number.isInteger(keepBuilds) || keepBuilds < 1) {
    console.error("usage: prune-fork-release-assets.cjs <tag> [keepBuilds=3] [--dry-run]");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY || "StartHex/netcatty-ci";
  const release = JSON.parse(gh(["api", `repos/${repo}/releases/tags/${tag}`]));
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = JSON.parse(gh(["api", `repos/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`]));
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  const plan = planPrune(assets, keepBuilds);
  console.log(`${tag}: ${assets.length} assets, keeping builds ${plan.keptBuilds.join(", ")}`);
  for (const asset of plan.remove) {
    console.log(`${dryRun ? "would delete" : "delete"} ${asset.name}`);
    if (!dryRun) gh(["api", "-X", "DELETE", `repos/${repo}/releases/assets/${asset.id}`]);
  }
  console.log(`${plan.remove.length} removed, ${plan.keep.length} kept`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { buildKeyOf, planPrune };
