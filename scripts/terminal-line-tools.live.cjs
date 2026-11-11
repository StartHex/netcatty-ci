/* Real desktop exercise of terminal line numbers, marks, go-to-line and
 * line-range copy. Run after `npm run build` on a machine with a display.
 * Set NETCATTY_LINE_TOOLS_SCREENSHOT=1 to print screenshots (base64 JPEG) to
 * the log. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Server } = require('ssh2');
const electron = require('electron');
const { applyElectronLaunchEnv } = require('../electron/launchEnv.cjs');
const { getTempFilePath } = require('../electron/bridges/tempDirBridge.cjs');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    child.once('exit', onExit);
  });
}
async function until(label, check, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class Devtools {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function clickPoint(cdp, { x, y }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const visiblePoint = (selector, index = 0) => `(() => {const items=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0});const e=items[${index}];if(!e)throw new Error('Missing visible element: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`;
async function clickElement(cdp, selector, index = 0) {
  await clickPoint(cdp, await cdp.eval(visiblePoint(selector, index)));
}
async function clickText(cdp, label, selector = 'button') {
  const point = await cdp.eval(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&x.getBoundingClientRect().x>=0);if(!e)throw new Error('Missing button: '+${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await clickPoint(cdp, point);
}
const win = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
async function insertText(mainCdp, value) {
  await mainCdp.eval(`${win}.webContents.insertText(${JSON.stringify(value)})`);
}
async function key(mainCdp, code, modifiers = []) {
  for (const type of ['keyDown', 'keyUp']) {
    await mainCdp.eval(`${win}.webContents.sendInputEvent({type:${JSON.stringify(type)},keyCode:${JSON.stringify(code)},modifiers:${JSON.stringify(modifiers)}})`);
  }
}
async function typeLine(mainCdp, value) {
  for (const letter of value) {
    await mainCdp.eval(`${win}.webContents.sendInputEvent({type:'char',keyCode:${JSON.stringify(letter)}})`);
  }
  await key(mainCdp, 'Enter');
}
async function focusTerminal(cdp) {
  const point = await cdp.eval(`(() => {const e=[...document.querySelectorAll('.xterm')].find(x=>x.getBoundingClientRect().x>=0);if(!e)throw new Error('No visible terminal');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height-20}})()`);
  await clickPoint(cdp, point);
}
const clipboardText = (mainCdp) => mainCdp.eval(`process.mainModule.require('electron').clipboard.readText()`);
const outLine = (n) => `out ${String(n).padStart(6, '0')}`;
const outLines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => outLine(from + i)).join('\n');

const GUTTER = '[data-section="terminal-line-number-gutter"]';
const PANEL = '[data-section="terminal-line-panel"]';
const gutterNumbers = (cdp) => cdp.eval(`[...document.querySelectorAll('${GUTTER} [data-row]')].filter(e=>e.style.display!=='none').map(e=>Number(e.textContent))`);
const markedNumbers = (cdp) => cdp.eval(`[...document.querySelectorAll('${GUTTER} [data-marked="true"]')].filter(e=>e.style.display!=='none').map(e=>Number(e.textContent))`);
const panelMarks = (cdp) => cdp.eval(`[...document.querySelectorAll('${PANEL} [data-terminal-line-mark]')].map(e=>Number(e.dataset.terminalLineMark))`);
const panelText = (cdp) => cdp.eval(`document.querySelector('${PANEL}')?.innerText ?? ''`);

async function screenshot(cdp, name) {
  if (process.env.NETCATTY_LINE_TOOLS_SCREENSHOT !== '1') return;
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  console.log(`-----BEGIN ${name}.jpg-----`);
  console.log(data.replace(/(.{120})/g, '$1\n'));
  console.log(`-----END ${name}.jpg-----`);
}

/** SSH server whose shell prints N numbered lines for `dump N`. */
function startSshFixture() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const state = { ready: false, dumps: 0 };
  const clients = new Set();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'fixture-login') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const channel = accept();
        channel.on('pty', (acceptPty) => acceptPty && acceptPty());
        channel.on('shell', (acceptShell) => {
          const stream = acceptShell();
          state.ready = true;
          let line = '';
          stream.write('fixture$ ');
          stream.on('data', (buffer) => {
            for (const char of buffer.toString('utf8')) {
              if (char === '\r' || char === '\n') {
                if (!line) continue;
                const submitted = line;
                line = '';
                const match = /^dump (\d+)$/.exec(submitted);
                if (match) {
                  let text = '';
                  for (let n = 1; n <= Number(match[1]); n += 1) text += `\r\n${outLine(n)}`;
                  stream.write(`${text}\r\nfixture$ `);
                  state.dumps += 1;
                } else {
                  stream.write('\r\nfixture$ ');
                }
              } else if (char === '\x7f') line = line.slice(0, -1);
              else line += char;
            }
          });
        });
      });
    });
  });
  return { server, state, clients };
}

async function main() {
  assert(fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')), 'Build the app first');
  const fixture = startSshFixture();
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const sshPort = fixture.server.address().port;
  const debugPort = await freePort();
  const inspectPort = await freePort();
  const testDir = fs.mkdtempSync(`${getTempFilePath('line-tools-test')}-`);
  const output = [];
  const app = spawn(electron, ['.', `--user-data-dir=${testDir}`, `--remote-debugging-port=${debugPort}`, `--inspect=${inspectPort}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    cwd: path.join(__dirname, '..'), env: applyElectronLaunchEnv({ ...process.env, VITE_DEV_SERVER_URL: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [app.stdout, app.stderr]) {
    stream.on('data', (data) => { output.push(data.toString()); if (output.length > 200) output.shift(); });
  }
  let cdp;
  let mainCdp;
  const guard = setTimeout(() => {
    console.error('Line tools desktop test exceeded its 150-second limit');
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    else app.kill('SIGKILL');
    process.exit(1);
  }, 150000);
  try {
    const target = await until('Electron renderer', async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      return (await response.json()).find((item) => item.type === 'page' && /index\.html/.test(item.url));
    }, 30000);
    cdp = new Devtools(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.bringToFront');
    const inspectTarget = await until('Electron main inspector', async () => {
      const response = await fetch(`http://127.0.0.1:${inspectPort}/json/list`);
      return (await response.json())[0];
    }, 15000);
    mainCdp = new Devtools(inspectTarget.webSocketDebuggerUrl);
    await mainCdp.connect();
    await mainCdp.eval(`${win}.focus()`);

    // Connect to the fixture through the quick-connect flow.
    await until('host search field', () => cdp.eval(`Boolean(document.querySelector('input[placeholder^="Find a host"]'))`), 15000);
    await clickElement(cdp, 'input[placeholder^="Find a host"]');
    await insertText(mainCdp, `ssh -p ${sshPort} fixture@127.0.0.1`);
    await until('quick-connect address', () => cdp.eval(`document.querySelector('input[placeholder^="Find a host"]')?.value.includes('fixture@127.0.0.1')`));
    await clickText(cdp, 'Connect');
    await until('protocol step', () => cdp.eval(`document.body.innerText.includes('Choose protocol')`));
    await clickText(cdp, 'Continue');
    await until('username step', () => cdp.eval(`Boolean(document.querySelector('input[placeholder="root"]'))`));
    await clickText(cdp, 'Continue');
    await until('password step', () => cdp.eval(`Boolean(document.querySelector('input[placeholder="Enter password"]'))`));
    await clickElement(cdp, 'input[placeholder="Enter password"]');
    await insertText(mainCdp, 'fixture-login');
    await clickText(cdp, 'Continue');
    await until('host-key confirmation', () => cdp.eval(`document.body.innerText.includes('Confirm this host key')`));
    await clickText(cdp, 'Add and continue');
    await until('connected terminal', async () => fixture.state.ready && cdp.eval(`document.querySelectorAll('.xterm').length === 1`), 20000);
    await pause(400);

    // 400 numbered lines: buffer row 1 is the prompt, row n+1 is "out n".
    await focusTerminal(cdp);
    await typeLine(mainCdp, 'dump 400');
    await until('dump output', () => fixture.state.dumps === 1, 10000);
    await pause(500);

    // Line numbers on.
    await clickElement(cdp, '[data-terminal-line-numbers-toggle]');
    const bottomNumbers = await until('line number gutter', async () => {
      const numbers = await gutterNumbers(cdp);
      return numbers.length > 3 && numbers.at(-1) === 402 ? numbers : null;
    }, 8000);
    assert.deepEqual(bottomNumbers, bottomNumbers.map((_, index) => bottomNumbers[0] + index), 'gutter numbers are consecutive');
    await screenshot(cdp, 'line-numbers');

    // Go to line with the shortcut, then type a line number.
    await focusTerminal(cdp);
    await key(mainCdp, 'G', process.platform === 'darwin' ? ['meta'] : ['control', 'shift']);
    await until('line panel', () => cdp.eval(`document.activeElement?.hasAttribute('data-terminal-line-input') === true`), 5000);
    await insertText(mainCdp, '120');
    await key(mainCdp, 'Enter');
    await until('line 120 on screen', async () => (await gutterNumbers(cdp)).includes(120), 5000);
    assert.ok(!(await gutterNumbers(cdp)).includes(402), 'the view left the bottom');
    await screenshot(cdp, 'go-to-line');

    // Copy a range typed into the same box.
    await cdp.eval(`(() => {const e=document.querySelector('[data-terminal-line-input]');e.focus();e.select();})()`);
    await insertText(mainCdp, '120-125');
    await until('range typed', () => cdp.eval(`document.querySelector('[data-terminal-line-input]')?.value === '120-125'`), 3000);
    await clickElement(cdp, `${PANEL} button[aria-label^="Copy these lines"]`);
    await until('range on clipboard', async () => (await clipboardText(mainCdp)) === outLines(119, 124), 5000);
    // The same through the keyboard.
    await cdp.eval(`(() => {const e=document.querySelector('[data-terminal-line-input]');e.focus();e.select();})()`);
    await insertText(mainCdp, '130-131');
    await key(mainCdp, 'Enter', process.platform === 'darwin' ? ['meta'] : ['control']);
    await until('keyboard range on clipboard', async () => (await clipboardText(mainCdp)) === outLines(129, 130), 5000);

    // Mark three lines by clicking their numbers.
    const visible = await gutterNumbers(cdp);
    const picks = [2, 5, 8].map((row) => visible[row]);
    for (const row of [2, 5, 8]) await clickElement(cdp, `${GUTTER} [data-row]`, row);
    await until('three marks in the gutter', async () => {
      const marked = await markedNumbers(cdp);
      return marked.length === 3 && marked.every((n, index) => n === picks[index]);
    }, 5000);
    assert.deepEqual(await panelMarks(cdp), picks, 'the panel lists the marks with their line numbers');
    await screenshot(cdp, 'marks-and-panel');

    // Copy everything between the first and the last mark.
    await clickElement(cdp, `${PANEL} button.w-full`);
    await until('marks range on clipboard', async () => (await clipboardText(mainCdp)) === outLines(picks[0] - 1, picks[2] - 1), 5000);

    // A far-away fourth mark, then cycle through all four with the shortcut.
    await cdp.eval(`(() => {const e=document.querySelector('[data-terminal-line-input]');e.focus();e.select();})()`);
    await insertText(mainCdp, '350');
    await key(mainCdp, 'Enter');
    await until('line 350 on screen', async () => (await gutterNumbers(cdp)).includes(350), 5000);
    const farIndex = (await gutterNumbers(cdp)).indexOf(350);
    await clickElement(cdp, `${GUTTER} [data-row]`, farIndex);
    await until('four marks', async () => (await panelMarks(cdp)).length === 4, 5000);
    const all = await panelMarks(cdp);
    assert.deepEqual(all, [...picks, 350]);

    await focusTerminal(cdp);
    const stepKeys = process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift'];
    // The view is at the fourth mark and nothing was visited yet, so the first
    // press lands on it; after that the walk wraps to the first mark.
    const said = (index, line) => cdp.eval(`document.body.innerText.includes(${JSON.stringify(`Mark ${index}/4 · line ${line}`)})`);
    await key(mainCdp, 'Down', stepKeys);
    await until('next mark: fourth', async () => (await said(4, all[3])) && (await gutterNumbers(cdp)).includes(all[3]), 5000);
    for (const index of [1, 2, 3]) {
      await key(mainCdp, 'Down', stepKeys);
      await until(`next mark: ${index}`, async () => (await said(index, all[index - 1])) && (await gutterNumbers(cdp)).includes(all[index - 1]), 5000);
    }
    assert.ok(!(await gutterNumbers(cdp)).includes(350), 'wrapped back up to the first marks');
    await key(mainCdp, 'Down', stepKeys);
    await until('next mark wraps to the fourth', async () => (await gutterNumbers(cdp)).includes(350), 5000);
    await key(mainCdp, 'Up', stepKeys);
    await until('previous mark goes back to the third', async () => {
      const numbers = await gutterNumbers(cdp);
      return numbers.includes(all[2]) && !numbers.includes(350);
    }, 5000);
    await key(mainCdp, 'Up', stepKeys);
    await key(mainCdp, 'Up', stepKeys);
    await key(mainCdp, 'Up', stepKeys);
    await until('previous mark wraps to the last', async () => (await gutterNumbers(cdp)).includes(350), 5000);

    // Line numbers off again: the gutter goes, the marks stay.
    await clickElement(cdp, '[data-terminal-line-numbers-toggle]');
    await until('gutter hidden', () => cdp.eval(`!document.querySelector('${GUTTER}')`), 5000);
    assert.equal((await panelMarks(cdp)).length, 4);
    assert.match(await panelText(cdp), /Marks \(4\)/);
    console.log('PASS: line numbers, go to line, range copy, marks, mark cycling and copy between marks');
  } catch (error) {
    await screenshot(cdp, 'failure').catch(() => {});
    console.error(`Electron output before failure:\n${output.join('').slice(-3000)}`);
    throw error;
  } finally {
    clearTimeout(guard);
    cdp?.close();
    mainCdp?.close();
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      if (!await waitForExit(app, 4000)) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
        else app.kill('SIGKILL');
        await waitForExit(app, 4000);
      }
    }
    for (const client of fixture.clients) client.destroy();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      fixture.server.close(() => { clearTimeout(timer); resolve(); });
    });
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
