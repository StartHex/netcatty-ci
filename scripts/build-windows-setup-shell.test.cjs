"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  toAssemblyVersion,
  readTrailer,
  assembleSetup,
  buildIco,
  assemblyInfoSource,
} = require("./build-windows-setup-shell.cjs");

test("fork versions become four-part assembly versions", () => {
  assert.equal(toAssemblyVersion("1.1.90-fork.32"), "1.1.90.32");
  assert.equal(toAssemblyVersion("1.2.3"), "1.2.3.0");
  assert.equal(toAssemblyVersion("0.0.0-fork-ced6226"), "0.0.0.6226");
  assert.equal(toAssemblyVersion("1.1.90-fork.99999"), "1.1.90.65534");
  assert.match(assemblyInfoSource("1.1.90-fork.32"), /AssemblyInformationalVersion\("1\.1\.90-fork\.32"\)/);
});

test("the assembled file keeps the stub first and the trailer reads back", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-setup-shell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, "stub.exe");
  const installer = path.join(dir, "installer.exe");
  const out = path.join(dir, "out", "setup.exe");
  fs.writeFileSync(stub, Buffer.from("MZ-stub-bytes"));
  const payload = Buffer.alloc(300_000, 7);
  fs.writeFileSync(installer, payload);

  assembleSetup({ stub, installer, out, meta: { version: "1.1.90-fork.32", unpackedBytes: 1234, empty: "" } });

  const written = fs.readFileSync(out);
  assert.equal(written.subarray(0, 13).toString(), "MZ-stub-bytes");
  const trailer = readTrailer(out);
  assert.equal(trailer.payloadOffset, 13);
  assert.equal(trailer.payloadLength, payload.length);
  assert.deepEqual(trailer.meta, { version: "1.1.90-fork.32", unpackedBytes: "1234" });
  assert.ok(written.subarray(trailer.payloadOffset, trailer.payloadOffset + payload.length).equals(payload));
  assert.equal(readTrailer(stub), null);
});

test("the shell source reads the same trailer layout", () => {
  const source = fs.readFileSync(path.join(__dirname, "windows-setup", "NetcattySetup.cs"), "utf8");
  assert.match(source, /const string Magic = "NCSETUP1"/);
  assert.match(source, /const int footer = 8 \+ 4 \+ 8;/);
  // The .NET Framework compiler stops at C# 5.
  assert.doesNotMatch(source, /\$"/);
  assert.doesNotMatch(source, /[\w)\]]\?\.\w/);
  assert.doesNotMatch(source, /\bnameof\(/);
});

test("ico directory points at each embedded png", () => {
  const icons = path.join(__dirname, "..", "build", "icons");
  const files = ["16x16", "256x256"].map((size) => path.join(icons, `${size}.png`));
  const ico = buildIco(files);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 16), 0);
  const secondOffset = ico.readUInt32LE(6 + 16 + 12);
  assert.equal(ico.subarray(secondOffset, secondOffset + 8).toString("latin1"), "\x89PNG\r\n\x1a\n");
});
