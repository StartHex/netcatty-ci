/* Real desktop exercise of note tabs: a note opened from the notes page gets
 * its own top tab. Run after `npm run build` on a machine with a display.
 * Set NETCATTY_NOTE_TABS_SCREENSHOT=1 to print a screenshot (base64 JPEG). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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

async function screenshot(cdp, name) {
  if (process.env.NETCATTY_NOTE_TABS_SCREENSHOT !== '1') return;
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  console.log(`-----BEGIN ${name}.jpg-----`);
  console.log(data.replace(/(.{120})/g, '$1\n'));
  console.log(`-----END ${name}.jpg-----`);
}

const SURFACE = '[data-section="note-tab-surface"]';
const noteTabs = (cdp) => cdp.eval(`[...document.querySelectorAll('[data-tab-type="note"]')].map(e=>({active:e.dataset.state==='active',text:e.innerText.trim()}))`);
const surfaceState = (cdp) => cdp.eval(`(() => {const s=document.querySelector('${SURFACE}');if(!s)return null;return {active:!s.hasAttribute('data-inactive-app-surface'),title:Boolean(s.querySelector('[data-note-title-row] input')),tree:Boolean(s.querySelector('[data-notes-area-switch]')),value:s.querySelector('[data-note-title-row] input')?.value ?? null}})()`);

async function main() {
  assert(fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')), 'Build the app first');
  const debugPort = await freePort();
  const inspectPort = await freePort();
  const testDir = fs.mkdtempSync(`${getTempFilePath('note-tabs-test')}-`);
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
    console.error('Note tabs desktop test exceeded its 120-second limit');
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    else app.kill('SIGKILL');
    process.exit(1);
  }, 120000);
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

    // Notes page, two new notes.
    await until('vault navigation', () => cdp.eval(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Notes')`), 20000);
    await clickText(cdp, 'Notes');
    await until('empty notes page', () => cdp.eval(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Note')`), 15000);
    await clickText(cdp, 'New Note');
    await until('first note', () => cdp.eval(`document.querySelectorAll('[data-note-id]').length === 1`), 10000);
    await clickElement(cdp, '[data-note-title-row] input');
    await insertText(mainCdp, 'Deploy checklist');
    await key(mainCdp, 'Enter');
    await until('first note titled', () => cdp.eval(`[...document.querySelectorAll('[data-note-id]')].some(e=>e.innerText.includes('Deploy checklist'))`), 5000);
    assert.deepEqual(await noteTabs(cdp), [], 'creating a note does not open a tab');

    // Clicking the note opens it in a tab and goes there.
    await clickElement(cdp, '[data-note-id]');
    await until('note tab', async () => {
      const tabs = await noteTabs(cdp);
      return tabs.length === 1 && tabs[0].active && tabs[0].text.includes('Deploy checklist');
    }, 10000);
    const shown = await until('note tab surface', async () => {
      const state = await surfaceState(cdp);
      return state && state.active && state.title ? state : null;
    }, 15000);
    assert.equal(shown.value, 'Deploy checklist', 'the tab shows the clicked note');
    assert.equal(shown.tree, false, 'a note tab has no notes tree');
    await screenshot(cdp, 'note-tab');

    // Renaming in the tab renames the tab.
    await clickElement(cdp, `${SURFACE} [data-note-title-row] input`);
    await key(mainCdp, 'End');
    await insertText(mainCdp, ' v2');
    await key(mainCdp, 'Enter');
    await until('tab title follows the note', async () => (await noteTabs(cdp))[0]?.text.includes('Deploy checklist v2'), 5000);

    // Clicking the same note again reuses its tab.
    await clickElement(cdp, '[data-tab-id="vault"], [data-tab-type="vault"]').catch(() => clickText(cdp, 'Vaults'));
    await until('back on the vault', async () => (await surfaceState(cdp))?.active === false, 5000);
    await clickElement(cdp, '[data-note-id]');
    await until('same tab again', async () => {
      const tabs = await noteTabs(cdp);
      return tabs.length === 1 && tabs[0].active;
    }, 5000);

    // Closing the tab leaves the note alone.
    await clickElement(cdp, '[data-tab-type="note"] button[aria-label="Close note tab"]');
    await until('tab closed', async () => (await noteTabs(cdp)).length === 0, 5000);
    await until('note still listed', () => cdp.eval(`document.querySelectorAll('[data-note-id]').length === 1`), 5000);
    console.log('PASS: a note opens in its own tab, the tab follows the title, reopening reuses it, closing keeps the note');
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
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
