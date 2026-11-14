'use strict';

// Windows only, run with Electron: starts a real elevated cmd.exe and a real
// elevated PowerShell through the UAC launch path and talks to them through
// the helper pipe. On a CI runner the session is already an administrator
// with the prompt disabled, so the launch goes through without a click; the
// path exercised (Start-Process -Verb RunAs, Electron as node, node-pty in
// the helper, the pipe protocol) is the one users take.
if (!process.versions.electron || process.platform !== 'win32') {
  require('node:test')('elevated local pty Electron integration', {
    skip: 'run on Windows: electron scripts/elevated-local-pty.live.test.cjs',
  }, () => {});
} else {
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const { app } = require('electron');
  const { spawnElevatedPty } = require('../electron/bridges/terminalBridge/elevatedLocalPty.cjs');

  // The integrity level a process started "as administrator" runs at.
  const HIGH_INTEGRITY_SID = 'S-1-16-12288';

  const waitForOutput = (state, pattern, label, ms = 30000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pattern.test(state.output)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}. Output so far:\n${state.output.slice(-1500)}`));
      }
    }, 100);
  });

  async function exercise(name, request, commands) {
    const proc = await spawnElevatedPty({ cols: 120, rows: 30, cwd: os.homedir(), env: { TERM: 'xterm-256color' }, ...request });
    assert.ok(proc.pid > 0, `${name}: the shell has a pid`);
    const state = { output: '' };
    proc.onData((text) => { state.output += text; });
    const exited = new Promise((resolve) => proc.onExit(resolve));

    proc.write(commands.integrity);
    await waitForOutput(state, new RegExp(HIGH_INTEGRITY_SID), `${name}: high integrity level`);
    proc.resize(90, 20);
    proc.write(commands.size);
    await waitForOutput(state, commands.sizePattern, `${name}: the new window size`);
    proc.write(commands.unicode);
    await waitForOutput(state, /netcatty-你好-ok/, `${name}: UTF-8 round trip`);
    proc.write(commands.exit);
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${name}: the shell did not exit`)), 15000)),
    ]);
    assert.equal(exit.exitCode, 3, `${name}: exit code is relayed`);
    console.log(`ELEVATED_PTY_PASS ${name}: pid ${proc.pid}, high integrity, resize, UTF-8, exit code`);
  }

  async function main() {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    await exercise('cmd', { shell: `${systemRoot}\\System32\\cmd.exe`, args: [] }, {
      integrity: 'whoami /groups | findstr /c:"S-1-16-"\r',
      size: 'mode con\r',
      sizePattern: /Columns:\s+90/,
      unicode: 'chcp 65001 >nul & echo netcatty-你好-ok\r',
      exit: 'exit 3\r',
    });
    await exercise('powershell', {
      shell: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoLogo', '-NoProfile'],
    }, {
      integrity: 'whoami /groups | Select-String "S-1-16-"\r',
      size: '"width=" + $Host.UI.RawUI.WindowSize.Width\r',
      sizePattern: /width=90/,
      unicode: '[Console]::OutputEncoding=[Text.Encoding]::UTF8; "netcatty-" + [char]0x4F60 + [char]0x597D + "-ok"\r',
      exit: 'exit 3\r',
    });

    // Closing the tab: kill() must take the elevated shell down with it.
    const proc = await spawnElevatedPty({ shell: `${systemRoot}\\System32\\cmd.exe`, args: [], cols: 80, rows: 24 });
    const pid = proc.pid;
    const exited = new Promise((resolve) => proc.onExit(resolve));
    proc.kill();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('kill did not end the session')), 10000))]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'the elevated shell is gone after kill');
    console.log('ELEVATED_PTY_PASS kill: the elevated shell ended with the tab');
  }

  app.on('window-all-closed', () => {});
  app.whenReady().then(main).then(
    () => app.exit(0),
    (error) => { console.error(error); app.exit(1); },
  );
}
