#!/usr/bin/env node
"use strict";

// Exercises a built setup shell on a Windows runner.
//
//   node scripts/test-windows-setup-shell.cjs --shell <exe> --screens [--dump]
//       renders every screen to PNG (--dump prints them base64 to the log, the
//       only way to look at them where artifacts cannot be downloaded)
//   node scripts/test-windows-setup-shell.cjs --shell <exe> --install
//       runs a real unattended install into a scratch folder, checks the app
//       is there, then removes it again

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "");
    if (key === "shell" || key === "out" || key === "lang") options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function runShell(shell, args, timeoutMs) {
  const result = spawnSync(shell, args, { timeout: timeoutMs, windowsHide: false });
  if (result.error) throw result.error;
  return result.status;
}

function printLog(file) {
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, "utf8").trimEnd());
}

function screens(shell, options) {
  const outDir = path.resolve(options.out || path.join(os.tmpdir(), `netcatty-setup-screens-${process.pid}`));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const log = path.join(outDir, "selftest.log");
  const langArgs = options.lang ? ["--lang", options.lang] : [];
  const status = runShell(shell, ["--selftest", outDir, "--log", log, ...langArgs], 120_000);
  printLog(log);
  if (status !== 0) throw new Error(`self test exited with ${status}`);
  for (const name of ["welcome.png", "installing.png", "done.png", "failed.png"]) {
    const file = path.join(outDir, name);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size < 2000) throw new Error(`${name} was not rendered`);
    console.log(`${name}: ${size} bytes`);
  }
  if (options.dump) {
    // The screen captures show what the compositor really draws; the off-screen
    // renders are only needed where there is no desktop to capture.
    const all = fs.readdirSync(outDir).filter((file) => file.endsWith(".png"));
    const captured = all.filter((file) => file.startsWith("screen-"));
    for (const name of captured.length > 0 ? captured : all) {
      console.log(`-----BEGIN ${name}-----`);
      console.log(fs.readFileSync(path.join(outDir, name)).toString("base64").replace(/(.{120})/g, "$1\n"));
      console.log(`-----END ${name}-----`);
    }
  }
  console.log(`screens written to ${outDir}`);
}

function install(shell) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-setup-install-"));
  const dir = path.join(root, "Netcatty Test", "Netcatty");
  const log = path.join(root, "install.log");
  try {
    const status = runShell(shell, ["--auto", "--dir", dir, "--log", log], 600_000);
    printLog(log);
    if (status !== 0) throw new Error(`unattended install exited with ${status}`);
    const exe = path.join(dir, "Netcatty.exe");
    if (!fs.existsSync(exe)) throw new Error(`${exe} is missing after install`);
    console.log(`installed: ${exe} (${fs.statSync(exe).size} bytes)`);
    const uninstaller = fs.readdirSync(dir).find((name) => /^Uninstall .*\.exe$/i.test(name));
    if (!uninstaller) throw new Error("uninstaller is missing after install");
    // NSIS copies the uninstaller to a temp folder and returns at once unless
    // _?= pins it to the install folder.
    const removed = spawnSync(path.join(dir, uninstaller), ["/S", `_?=${dir}`], { timeout: 300_000, windowsVerbatimArguments: true });
    console.log(`uninstaller exited with ${removed.status}`);
    if (fs.existsSync(exe)) throw new Error("Netcatty.exe is still there after uninstall");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("Windows only.");
  if (!options.shell) throw new Error("--shell <exe> is required");
  const shell = path.resolve(options.shell);
  if (options.screens) screens(shell, options);
  if (options.install) install(shell);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
