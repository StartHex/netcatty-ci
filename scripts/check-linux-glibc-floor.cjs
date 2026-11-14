#!/usr/bin/env node
/**
 * Reports the newest glibc symbol version each native module in a packaged
 * Linux app needs, and fails when node-pty (compiled during packaging, loaded
 * at startup) needs a newer glibc than the oldest supported distribution has.
 *
 *   node scripts/check-linux-glibc-floor.cjs release/linux-unpacked 2.28
 *
 * A module that needs a newer glibc than the machine has cannot be loaded,
 * and the app then fails to start there.
 */
const fs = require("node:fs");
const path = require("node:path");

function parseVersion(text) {
  const [major, minor = 0] = String(text).split(".").map(Number);
  return { major, minor };
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor;
}

/** Newest `GLIBC_x.y` version named in an ELF file, or null. */
function newestGlibcVersion(buffer) {
  if (buffer.length < 4 || buffer.readUInt32BE(0) !== 0x7f454c46) return null;
  const text = buffer.toString("latin1");
  let newest = null;
  for (const match of text.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = { major: Number(match[1]), minor: Number(match[2]) };
    if (!newest || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

function listNativeFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (entry.name.endsWith(".node") || entry.name === "spawn-helper")) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function checkGlibcFloor(root, floorText) {
  const floor = parseVersion(floorText);
  const results = [];
  for (const file of listNativeFiles(root)) {
    const newest = newestGlibcVersion(fs.readFileSync(file));
    if (!newest) continue;
    results.push({
      file,
      version: `${newest.major}.${newest.minor}`,
      aboveFloor: compareVersions(newest, floor) > 0,
      // Only node-pty is compiled by the packaging job itself.
      required: file.split(path.sep).includes("node-pty"),
    });
  }
  return results;
}

function main() {
  const [root, floor = "2.28"] = process.argv.slice(2);
  if (!root || !fs.existsSync(root)) {
    console.error("usage: check-linux-glibc-floor.cjs <unpacked app dir> [glibc version]");
    process.exit(2);
  }
  const unpacked = path.join(root, "resources", "app.asar.unpacked");
  const results = checkGlibcFloor(fs.existsSync(unpacked) ? unpacked : root, floor);
  if (results.length === 0) {
    console.error(`[glibc] no native modules found under ${root}`);
    process.exit(1);
  }
  let failed = false;
  for (const result of results) {
    const relative = path.relative(root, result.file);
    console.log(`[glibc] ${result.version.padEnd(5)} ${relative}`);
    if (!result.aboveFloor) continue;
    if (result.required) {
      failed = true;
      console.error(`::error::${relative} needs glibc ${result.version}, newer than ${floor}`);
    } else {
      console.log(`::warning::${relative} needs glibc ${result.version}, newer than ${floor}`);
    }
  }
  if (!results.some((result) => result.required)) {
    console.error("[glibc] node-pty native module not found");
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { newestGlibcVersion, checkGlibcFloor, compareVersions, parseVersion };
