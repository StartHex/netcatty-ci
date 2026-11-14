const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { newestGlibcVersion, checkGlibcFloor } = require("./check-linux-glibc-floor.cjs");

const elf = (...symbols) => Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from(`\0${symbols.join("\0")}\0`, "latin1"),
]);

test("newestGlibcVersion picks the highest version, comparing numerically", () => {
  assert.deepEqual(newestGlibcVersion(elf("GLIBC_2.2.5", "GLIBC_2.28", "GLIBC_2.4")), { major: 2, minor: 28 });
  assert.deepEqual(newestGlibcVersion(elf("GLIBC_2.9", "GLIBC_2.34")), { major: 2, minor: 34 });
  assert.equal(newestGlibcVersion(elf("GLIBCXX_3.4")), null);
  assert.equal(newestGlibcVersion(Buffer.from("GLIBC_2.34 but not an ELF file")), null);
});

test("checkGlibcFloor flags modules above the floor and marks node-pty as required", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glibc-floor-"));
  try {
    const pty = path.join(root, "node_modules", "node-pty", "build", "Release");
    const other = path.join(root, "node_modules", "other", "prebuilds");
    fs.mkdirSync(pty, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(pty, "pty.node"), elf("GLIBC_2.34"));
    fs.writeFileSync(path.join(pty, "spawn-helper"), elf("GLIBC_2.17"));
    fs.writeFileSync(path.join(other, "x.node"), elf("GLIBC_2.28"));
    fs.writeFileSync(path.join(other, "readme.txt"), "GLIBC_2.99");

    const results = checkGlibcFloor(root, "2.28").map((r) => ({
      file: path.relative(root, r.file).split(path.sep).join("/"),
      version: r.version,
      aboveFloor: r.aboveFloor,
      required: r.required,
    }));
    assert.deepEqual(results, [
      { file: "node_modules/node-pty/build/Release/pty.node", version: "2.34", aboveFloor: true, required: true },
      { file: "node_modules/node-pty/build/Release/spawn-helper", version: "2.17", aboveFloor: false, required: true },
      { file: "node_modules/other/prebuilds/x.node", version: "2.28", aboveFloor: false, required: false },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
