#!/usr/bin/env node
"use strict";

// Runs a built setup shell through the ways people really install:
//   fresh      default folder, nothing installed before
//   upgrade    again over the copy the first run installed
//   running    again while the installed app is running
//   click      a real mouse click on the Install button (no --auto)
// Each step has a time limit; when one runs out the script prints the shell's
// log, the process list and a screenshot, so a hang can be read from the log.
//
//   node scripts/test-windows-setup-scenarios.cjs --shell <exe>

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const STEP_LIMIT_MS = 5 * 60_000;
const installDir = path.join(process.env.LOCALAPPDATA || "", "Programs", "Netcatty");
const appExe = path.join(installDir, "Netcatty.exe");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-setup-scenarios-"));

const machineDir = path.join(process.env.ProgramFiles || "C:\\Program Files", "Netcatty");
const { readTrailer } = require("./build-windows-setup-shell.cjs");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function powershell(script, timeout = 60_000) {
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function printLog(file) {
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, "utf8").trimEnd());
  else console.log(`(no log at ${file})`);
}

function diagnostics(label) {
  console.log(`--- diagnostics: ${label} ---`);
  console.log(powershell("Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Netcatty|Uninstall|nsis|Au_' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List"));
  const shot = path.join(workDir, `${label}.jpg`);
  powershell(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${shot.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Jpeg)`);
  if (fs.existsSync(shot)) {
    console.log(`-----BEGIN ${label}.jpg-----`);
    console.log(fs.readFileSync(shot).toString("base64").replace(/(.{120})/g, "$1\n"));
    console.log(`-----END ${label}.jpg-----`);
  }
}

/** Starts the shell and resolves with its exit code, or "timeout" after the limit. */
function runShell(shell, args, limit = STEP_LIMIT_MS) {
  return new Promise((resolve) => {
    const child = spawn(shell, args, { stdio: "ignore" });
    const timer = setTimeout(() => resolve({ child, status: "timeout" }), limit);
    child.once("exit", (code) => { clearTimeout(timer); resolve({ child, status: code }); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ child, status: `error: ${error.message}` }); });
  });
}

function killTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

function installedVersion() {
  if (!fs.existsSync(appExe)) return null;
  return powershell(`(Get-Item '${appExe.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
}

/** Copies the NSIS installer out of the shell, the way the shell does at run time. */
function extractInstaller(shell) {
  const trailer = readTrailer(shell);
  if (!trailer) throw new Error("the shell has no installer attached");
  const target = path.join(workDir, "Netcatty-Installer.exe");
  const input = fs.openSync(shell, "r");
  const output = fs.openSync(target, "w");
  const buffer = Buffer.alloc(4 << 20);
  let left = trailer.payloadLength;
  let position = trailer.payloadOffset;
  while (left > 0) {
    const read = fs.readSync(input, buffer, 0, Math.min(buffer.length, left), position);
    fs.writeSync(output, buffer, 0, read);
    left -= read;
    position += read;
  }
  fs.closeSync(input);
  fs.closeSync(output);
  return target;
}

async function autoStep(shell, name, expectedExe = appExe) {
  const log = path.join(workDir, `${name}.log`);
  const started = Date.now();
  const { child, status } = await runShell(shell, ["--auto", "--log", log]);
  const seconds = Math.round((Date.now() - started) / 1000);
  printLog(log);
  if (status === "timeout") {
    diagnostics(name);
    killTree(child.pid);
    throw new Error(`${name}: still running after ${seconds}s`);
  }
  if (status !== 0) {
    diagnostics(name);
    throw new Error(`${name}: exited with ${status} after ${seconds}s`);
  }
  if (!fs.existsSync(expectedExe)) throw new Error(`${name}: ${expectedExe} is missing`);
  console.log(`PASS ${name}: ${seconds}s, ${expectedExe}`);
}

const CLICK_HELPER = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NcWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
"@
$h = [NcWin]::FindWindow([NullString]::Value, 'Netcatty Setup')
if ($h -eq [IntPtr]::Zero) { Write-Output 'no-window'; exit }
[NcWin]::SetForegroundWindow($h) | Out-Null
$r = New-Object NcWin+RECT
[NcWin]::GetWindowRect($h, [ref]$r) | Out-Null
$sx = ($r.R - $r.L) / 720.0
$x = [int]($r.L + 360 * $sx); $y = [int]($r.T + 352 * $sx)
[NcWin]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 200
[NcWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[NcWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "clicked $x,$y in $($r.L),$($r.T),$($r.R),$($r.B)"
`;

async function clickStep(shell) {
  const name = "click";
  const log = path.join(workDir, `${name}.log`);
  const child = spawn(shell, ["--log", log, "--lang", "en"], { stdio: "ignore" });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    await pause(4000);
    console.log(powershell(CLICK_HELPER));
    const started = Date.now();
    let done = false;
    while (Date.now() - started < STEP_LIMIT_MS && !exited) {
      const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      if (/installed to /.test(text)) { done = true; break; }
      if (/failed: /.test(text)) break;
      await pause(1000);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    printLog(log);
    if (!done) {
      diagnostics(name);
      throw new Error(`${name}: no install after a real click (${seconds}s)`);
    }
    console.log(`PASS ${name}: ${seconds}s after the click`);
  } finally {
    if (!exited) killTree(child.pid);
  }
}

function uninstallFrom(dir) {
  if (!fs.existsSync(dir)) return;
  const uninstaller = fs.readdirSync(dir).find((file) => /^Uninstall .*\.exe$/i.test(file));
  if (!uninstaller) return;
  const result = spawnSync(path.join(dir, uninstaller), ["/S", `_?=${dir}`], { timeout: 300_000, windowsVerbatimArguments: true });
  console.log(`uninstall from ${dir} exited with ${result.status}`);
}

async function main() {
  const index = process.argv.indexOf("--shell");
  if (process.platform !== "win32" || index === -1) throw new Error("usage (Windows): --shell <exe>");
  const shell = path.resolve(process.argv[index + 1]);
  console.log(`shell ${shell} (${fs.statSync(shell).size} bytes), install dir ${installDir}`);
  if (fs.existsSync(appExe)) throw new Error("Netcatty is already installed on this machine");

  await autoStep(shell, "fresh");
  await autoStep(shell, "upgrade");

  const app = spawn(appExe, [], { stdio: "ignore", detached: true });
  app.unref();
  await pause(15_000);
  console.log(`app running: ${powershell("(Get-Process Netcatty -ErrorAction SilentlyContinue | Measure-Object).Count")} processes`);
  await autoStep(shell, "running");

  await clickStep(shell);
  uninstallFrom(installDir);

  // A copy installed for all users (Program Files), then updated by the shell.
  const installer = extractInstaller(shell);
  const classic = spawnSync(installer, ["/S", "/allusers"], { timeout: STEP_LIMIT_MS });
  console.log(`classic all-users install exited with ${classic.status}; ${machineDir} ${fs.existsSync(path.join(machineDir, "Netcatty.exe")) ? "has" : "lacks"} Netcatty.exe`);
  console.log(powershell("Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Netcatty*' } | Select-Object PSPath,DisplayName,InstallLocation,UninstallString | Format-List"));
  if (!fs.existsSync(path.join(machineDir, "Netcatty.exe"))) throw new Error("all-users install did not land in Program Files");
  await autoStep(shell, "machine-upgrade", path.join(machineDir, "Netcatty.exe"));
  uninstallFrom(machineDir);
  console.log("PASS: fresh install, upgrade, upgrade while running, a real click, and an all-users upgrade");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => {
  spawnSync("taskkill", ["/F", "/IM", "Netcatty.exe"]);
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
