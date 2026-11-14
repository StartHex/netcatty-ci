"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildKeyOf, planPrune } = require("./prune-fork-release-assets.cjs");

test("build key is the version part of an installer name", () => {
  assert.equal(buildKeyOf("Netcatty-1.1.90-fork.32-win-x64.exe"), "1.1.90-fork.32");
  assert.equal(buildKeyOf("Netcatty-0.0.0-fork-ced6226-mac-arm64.dmg"), "0.0.0-fork-ced6226");
  assert.equal(buildKeyOf("Netcatty-1.1.90-fork.32-mac-x64.zip"), "1.1.90-fork.32");
  assert.equal(buildKeyOf("latest.yml"), null);
});

test("keeps every asset of the newest builds and nothing else", () => {
  const asset = (name, day) => ({ id: name, name, updated_at: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z` });
  const assets = [
    asset("Netcatty-0.0.0-fork-aaaaaaa-mac-x64.dmg", 1),
    asset("Netcatty-0.0.0-fork-aaaaaaa-mac-x64.zip", 1),
    asset("Netcatty-1.1.90-fork.30-mac-x64.dmg", 5),
    asset("Netcatty-1.1.90-fork.31-mac-x64.dmg", 6),
    asset("Netcatty-1.1.90-fork.31-mac-x64.zip", 6),
    asset("Netcatty-1.1.90-fork.32-mac-x64.dmg", 7),
    asset("Netcatty-1.1.90-fork.9-mac-x64.dmg", 2),
    asset("notes.txt", 1),
  ];
  const plan = planPrune(assets, 3);
  assert.deepEqual(plan.keptBuilds, ["1.1.90-fork.32", "1.1.90-fork.31", "1.1.90-fork.30"]);
  assert.deepEqual(plan.remove.map((item) => item.name), [
    "Netcatty-0.0.0-fork-aaaaaaa-mac-x64.dmg",
    "Netcatty-0.0.0-fork-aaaaaaa-mac-x64.zip",
    "Netcatty-1.1.90-fork.9-mac-x64.dmg",
  ]);
  assert.equal(plan.keep.length, 5);
});

test("fewer builds than the limit removes nothing", () => {
  const plan = planPrune([{ id: 1, name: "Netcatty-1.1.90-fork.1-win-x64.exe", updated_at: "2026-11-01T00:00:00Z" }], 3);
  assert.equal(plan.remove.length, 0);
});
