#!/usr/bin/env node
"use strict";

// Builds the Netcatty setup shell for Windows: compiles
// scripts/windows-setup/NetcattySetup.cs with the .NET Framework C# compiler
// that ships with Windows, then appends the NSIS installer electron-builder
// produced plus a small footer the shell reads at start-up.
//
//   node scripts/build-windows-setup-shell.cjs \
//     --installer release/Netcatty-1.1.90-fork.40-win-x64.exe \
//     --out release/setup-shell/Netcatty-1.1.90-fork.40-win-x64.exe \
//     [--version 1.1.90-fork.40] [--unpacked release/win-unpacked]
//
// With --stub-only no installer is appended: the result opens and renders but
// cannot install, which is enough for the layout self test.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MAGIC = "NCSETUP1";
const repoRoot = path.resolve(__dirname, "..");

/** `1.1.90-fork.32` -> `1.1.90.32`: assembly versions are four numbers. */
function toAssemblyVersion(version) {
  const numbers = String(version).match(/\d+/g) || [];
  const parts = numbers.slice(0, 4).map((part) => Math.min(65534, Number(part)));
  while (parts.length < 4) parts.push(0);
  return parts.join(".");
}

function encodeMeta(meta) {
  const text = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`)
    .join("\n");
  return Buffer.from(text, "utf8");
}

/** Trailer after the payload: meta, payload length, meta length, magic. */
function buildTrailer(payloadLength, meta) {
  const metaBytes = encodeMeta(meta);
  const footer = Buffer.alloc(20);
  footer.writeBigInt64LE(BigInt(payloadLength), 0);
  footer.writeInt32LE(metaBytes.length, 8);
  footer.write(MAGIC, 12, "ascii");
  return Buffer.concat([metaBytes, footer]);
}

/** Mirror of Payload.Read in NetcattySetup.cs, for tests and build checks. */
function readTrailer(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    if (size < 20) return null;
    const footer = Buffer.alloc(20);
    fs.readSync(fd, footer, 0, 20, size - 20);
    if (footer.toString("ascii", 12, 20) !== MAGIC) return null;
    const payloadLength = Number(footer.readBigInt64LE(0));
    const metaLength = footer.readInt32LE(8);
    const metaOffset = size - 20 - metaLength;
    const payloadOffset = metaOffset - payloadLength;
    if (payloadLength <= 0 || metaLength < 0 || payloadOffset <= 0) return null;
    const metaBytes = Buffer.alloc(metaLength);
    fs.readSync(fd, metaBytes, 0, metaLength, metaOffset);
    const meta = {};
    for (const line of metaBytes.toString("utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return { payloadOffset, payloadLength, meta };
  } finally {
    fs.closeSync(fd);
  }
}

function appendFile(targetFd, source) {
  const fd = fs.openSync(source, "r");
  try {
    const buffer = Buffer.alloc(4 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      fs.writeSync(targetFd, buffer, 0, read);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** stub + installer + trailer -> out. */
function assembleSetup({ stub, installer, out, meta }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, "w");
  try {
    appendFile(fd, stub);
    appendFile(fd, installer);
    fs.writeSync(fd, buildTrailer(fs.statSync(installer).size, meta));
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/** An .ico that stores the given PNG files as-is (Windows Vista and later). */
function buildIco(pngFiles) {
  const images = pngFiles.map((file) => {
    const data = fs.readFileSync(file);
    return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(image.width >= 256 ? 0 : image.width, at);
    header.writeUInt8(image.height >= 256 ? 0 : image.height, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

function directorySize(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  }
  return total;
}

function frameworkDir() {
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  return path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319");
}

function assemblyInfoSource(version) {
  const numeric = toAssemblyVersion(version);
  const text = String(version).replace(/[^0-9A-Za-z.+-]/g, "");
  return [
    "using System.Reflection;",
    '[assembly: AssemblyTitle("Netcatty Setup")]',
    '[assembly: AssemblyProduct("Netcatty")]',
    '[assembly: AssemblyDescription("Netcatty Setup")]',
    '[assembly: AssemblyCompany("Netcatty")]',
    `[assembly: AssemblyVersion("${numeric}")]`,
    `[assembly: AssemblyFileVersion("${numeric}")]`,
    `[assembly: AssemblyInformationalVersion("${text}")]`,
    "",
  ].join("\r\n");
}

/** Compiles the shell without a payload. Windows only. */
function compileStub({ out, version, workDir }) {
  if (process.platform !== "win32") {
    throw new Error("The setup shell can only be compiled on Windows.");
  }
  const framework = frameworkDir();
  const csc = path.join(framework, "csc.exe");
  if (!fs.existsSync(csc)) throw new Error(`C# compiler not found at ${csc}`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const iconsDir = path.join(repoRoot, "build", "icons");
  const icoFile = path.join(workDir, "setup.ico");
  fs.writeFileSync(icoFile, buildIco(
    ["16x16", "32x32", "48x48", "64x64", "128x128", "256x256"].map((size) => path.join(iconsDir, `${size}.png`)),
  ));
  const infoFile = path.join(workDir, "AssemblyInfo.g.cs");
  fs.writeFileSync(infoFile, assemblyInfoSource(version));

  const wpf = path.join(framework, "WPF");
  const references = [
    path.join(framework, "System.dll"),
    path.join(framework, "System.Core.dll"),
    path.join(framework, "System.Xaml.dll"),
    path.join(framework, "System.Drawing.dll"),
    path.join(framework, "System.Windows.Forms.dll"),
    path.join(wpf, "WindowsBase.dll"),
    path.join(wpf, "PresentationCore.dll"),
    path.join(wpf, "PresentationFramework.dll"),
  ];
  const args = [
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    "/warnaserror-",
    `/out:${out}`,
    `/win32icon:${icoFile}`,
    `/resource:${path.join(iconsDir, "256x256.png")},icon.png`,
    ...references.map((file) => `/r:${file}`),
    path.join(__dirname, "windows-setup", "NetcattySetup.cs"),
    infoFile,
  ];
  execFileSync(csc, args, { stdio: "inherit" });
  return out;
}

function findInstaller(releaseDir) {
  const matches = fs.readdirSync(releaseDir)
    .filter((name) => /-win-x64\.exe$/i.test(name) && !/portable/i.test(name))
    .map((name) => path.join(releaseDir, name));
  if (matches.length !== 1) {
    throw new Error(`Expected one NSIS installer in ${releaseDir}, found ${matches.length}`);
  }
  return matches[0];
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "stub-only") options.stubOnly = true;
    else options[key] = argv[++index];
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const releaseDir = path.join(repoRoot, "release");
  const workDir = path.join(releaseDir, ".setup-shell");
  const version = options.version || require(path.join(repoRoot, "package.json")).version;
  const stub = path.join(workDir, "NetcattySetupStub.exe");
  compileStub({ out: stub, version, workDir });

  if (options.stubOnly) {
    const out = path.resolve(options.out || path.join(workDir, "NetcattySetup.exe"));
    if (out !== stub) fs.copyFileSync(stub, out);
    console.log(`setup shell stub: ${out} (${fs.statSync(out).size} bytes)`);
    return;
  }

  const installer = path.resolve(options.installer || findInstaller(releaseDir));
  const unpacked = path.resolve(options.unpacked || path.join(releaseDir, "win-unpacked"));
  const out = path.resolve(options.out || path.join(releaseDir, "setup-shell", path.basename(installer)));
  if (out === installer) throw new Error("--out must differ from --installer");
  const meta = {
    version,
    productName: "Netcatty",
    exeName: "Netcatty.exe",
    unpackedBytes: fs.existsSync(unpacked) ? directorySize(unpacked) : undefined,
  };
  assembleSetup({ stub, installer, out, meta });
  const check = readTrailer(out);
  if (!check || check.payloadLength !== fs.statSync(installer).size) {
    throw new Error("setup shell trailer does not read back");
  }
  console.log(`setup shell: ${out}`);
  console.log(`  stub ${fs.statSync(stub).size} bytes + installer ${check.payloadLength} bytes`);
  console.log(`  meta ${JSON.stringify(check.meta)}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = { toAssemblyVersion, buildTrailer, readTrailer, assembleSetup, buildIco, assemblyInfoSource };
