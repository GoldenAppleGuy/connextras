#!/usr/bin/env node
// Chromium (Edge / Chrome for Testing) test driver for the extension: the
// same HTTP API as dev/wf.mjs, over the Chrome DevTools Protocol.
//
// Launches the browser with a brand-new throwaway profile (no NYT login;
// deleted on exit), loads extension/ unpacked (--load-extension), and serves
// the API on 127.0.0.1 so scripts (or curl) can drive it.
//
//   node dev/cr.mjs [--headless] [--port 9333] [--url <start url>]
//
// Browser: $CHROME, else Microsoft Edge. Branded Google Chrome (137+)
// ignores --load-extension; use Edge or Chrome for Testing.
//
// Endpoints, token (x-wf-token, written to dev/out/.wf-token or
// .wf-token-<port>) and host check: see dev/wf.mjs. Differences:
//   /reload  reloads the page only; extension files are read once, at
//            launch (restart the driver after changing extension/).
//   /click?sel=  clicks the element's center, measured once it stops moving.
//   /drag?x1=&y1=&x2=&y2=[&button=right]  press, move, release (Chromium only)

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const BIN = process.env.CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const HTTP_PORT = +opt('--port', 9333);
const CDP_PORT = HTTP_PORT + 1;
const START_URL = opt('--url', 'https://www.nytimes.com/games/connections');
const OUT_DIR = path.join(ROOT, 'dev', 'out');
const TOKEN = crypto.randomBytes(16).toString('hex');
const TOKEN_FILE = path.join(OUT_DIR, HTTP_PORT === 9333 ? '.wf-token' : `.wf-token-${HTTP_PORT}`);
const VIEW = { width: 1400, height: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fresh profile ---
for (const d of fs.readdirSync(os.tmpdir())) {
  if (!d.startsWith('cw-chromium-')) continue;
  try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch (_) {}
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chromium-'));
const crArgs = [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  // Keep timers running in tabs that aren't in front (the two-tab test).
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--window-size=${VIEW.width},${VIEW.height}`,
  'about:blank',
];
if (flag('--headless')) crArgs.unshift('--headless=new');
const cr = spawn(BIN, crArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let send = null;
const cleanup = async () => {
  try { if (send) await Promise.race([send('Browser.close'), sleep(3000)]); } catch (_) {}
  try { cr.kill(); } catch (_) {}
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch (_) {}
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (_) {}
    process.exit(0);
  }, 1500);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
cr.on('exit', (code) => {
  console.log(`browser exited (${code})`);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (_) {}
  process.exit(0);
});

// --- CDP client (one browser connection, flat sessions per tab) ---
let version = null;
for (let n = 0; n < 120 && !version; n++) {
  try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch (_) { await sleep(250); }
}
if (!version) { console.error('browser did not open its debugging port'); await cleanup(); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const logs = [];
const loadWaiters = new Map(); // sessionId -> [resolve]
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Page.loadEventFired') {
    const w = loadWaiters.get(msg.sessionId) || [];
    loadWaiters.delete(msg.sessionId);
    w.forEach((r) => r());
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const p = msg.params;
    logs.push(`[${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    if (logs.length > 300) logs.shift();
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  }
};
send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT_DIR });

const tabs = []; // [{ targetId, session }]
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false }, sessionId);
  // Headless tabs never get real focus; NYT's game checks visibility/focus.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  return { targetId, session: sessionId };
}
const { targetInfos } = await send('Target.getTargets');
const first = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('edge://') && !t.url.startsWith('chrome://')) ||
  targetInfos.find((t) => t.type === 'page');
tabs.push(await attach(first.targetId));
let cur = tabs[0];
const S = (method, params) => send(method, params, cur.session);

async function evalJs(body) {
  const expression = `(async () => { ${body}\n})().then(v => JSON.stringify(v === undefined ? null : v))`;
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return JSON.parse(r.result.value);
}

async function waitInteractive() {
  try {
    await evalJs(`
      if (!location.href.includes('nytimes.com/games/connections')) return true;
      for (let n = 0; n < 150; n++) {
        const b = document.querySelector('[data-testid="connections-board"]');
        if (b && Object.keys(b).some((k) => k.startsWith('__reactProps'))) {
          await new Promise((r) => setTimeout(r, 300));
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    `);
  } catch (_) {}
}
function loaded(session, ms = 45000) {
  return Promise.race([
    new Promise((r) => loadWaiters.set(session, [...(loadWaiters.get(session) || []), r])),
    sleep(ms),
  ]);
}
async function nav(url) {
  const done = loaded(cur.session);
  await S('Page.navigate', { url });
  await done;
  await waitInteractive();
}

async function mouseClick(x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

// Same element lookup as dev/wf.mjs (exact word match first).
const findJs = (sel, i = 0, text = null) => `(() => {
  const T = ${JSON.stringify(text == null ? null : String(text).toUpperCase())};
  const norm = (s) => (s || '').trim().toUpperCase();
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  let all = els;
  if (T != null) {
    const exact = (e) => norm(e.textContent) === T ||
      [...e.children].some((k) => norm(k.textContent) === T) ||
      norm((e.querySelector('input') || {}).value) === T ||
      norm(e.getAttribute('aria-label')) === T;
    all = els.filter(exact);
    if (!all.length) all = els.filter((e) => norm(e.textContent).includes(T));
  }
  return all[${+i}] || null;
})()`;

async function rectOf(sel, i = 0, text = null) {
  return evalJs(`
    const el = ${findJs(sel, i, text)};
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  `);
}

async function clickElement(sel, i = 0, text = null) {
  const r = await evalJs(`
    let el = null;
    for (let n = 0; n < 50 && !(el = ${findJs(sel, i, text)}); n++)
      await new Promise((res) => setTimeout(res, 100));
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    let last = '', r;
    for (let n = 0; n < 20; n++) {
      r = el.getBoundingClientRect();
      const now = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
      if (now === last) break;
      last = now;
      await new Promise((res) => setTimeout(res, 100));
    }
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `);
  if (!r) throw new Error(`no element for ${sel} ${text || ''} (waited 5s)`);
  await mouseClick(r.x, r.y);
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
};

// --- HTTP API ---
const routes = {
  async nav(q) { await nav(q.get('url')); return { ok: true }; },
  async eval(q, body) { return evalJs(body); },
  async click(q) {
    if (q.get('sel')) {
      await clickElement(q.get('sel'), q.get('i') || 0, q.get('text'));
      return { ok: true };
    }
    const x = +q.get('x'), y = +q.get('y');
    await mouseClick(x, y);
    return { ok: true, x, y };
  },
  // Press at (x1,y1), move to (x2,y2) in steps, release; button=left|right.
  async drag(q) {
    const button = q.get('button') === 'right' ? 'right' : 'left';
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Math.round(+q.get(k)));
    const buttons = button === 'right' ? 2 : 1;
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button, buttons, clickCount: 1 });
    for (let n = 1; n <= 10; n++) {
      await sleep(30);
      await S('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button, buttons,
        x: Math.round(x1 + ((x2 - x1) * n) / 10), y: Math.round(y1 + ((y2 - y1) * n) / 10),
      });
    }
    await sleep(60);
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button, buttons: 0, clickCount: 1 });
    return { ok: true };
  },
  async key(q) {
    const k = q.get('k');
    let d = KEYS[k];
    if (!d) {
      const up = k.length === 1 ? k.toUpperCase() : k;
      const code = /^[0-9]$/.test(k) ? `Digit${k}` : /^[a-z]$/i.test(k) ? `Key${up}` : '';
      d = { key: k, code, windowsVirtualKeyCode: up.charCodeAt(0), text: k.length === 1 ? k : undefined };
    }
    await S('Input.dispatchKeyEvent', { type: d.text ? 'keyDown' : 'rawKeyDown', ...d });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', ...d, text: undefined });
    return { ok: true };
  },
  async shot(q) {
    const params = { format: 'png' };
    if (q.get('sel')) {
      const r = await rectOf(q.get('sel'), q.get('i') || 0);
      if (!r) throw new Error(`no element for ${q.get('sel')}`);
      const sc = await evalJs('return [scrollX, scrollY]');
      params.clip = { x: r.x + sc[0], y: r.y + sc[1], width: r.width, height: r.height, scale: 1 };
    }
    const { data } = await S('Page.captureScreenshot', params);
    const name = path.basename(q.get('out') || 'shot.png');
    if (!/^[\w.-]+\.png$/i.test(name)) throw new Error('out must be a .png file name');
    const out = path.join(OUT_DIR, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    return { ok: true, out };
  },
  async viewport(q) {
    const viewport = { width: +q.get('w') || VIEW.width, height: +q.get('h') || VIEW.height };
    await S('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    return { ok: true, viewport };
  },
  async setfiles(q) {
    const r = await S('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(q.get('sel'))})` });
    if (!r.result || r.result.subtype !== 'node') throw new Error(`no element for ${q.get('sel')}`);
    const file = path.resolve(ROOT, q.get('path'));
    await S('DOM.setFileInputFiles', { files: [file], objectId: r.result.objectId });
    return { ok: true, file };
  },
  async newtab(q) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const t = await attach(targetId);
    tabs.push(t);
    cur = t;
    if (q.get('url')) await nav(q.get('url'));
    return { ok: true, tab: tabs.length - 1 };
  },
  async tab(q) {
    const i = +q.get('i') || 0;
    if (!tabs[i]) throw new Error(`no tab ${i}`);
    cur = tabs[i];
    await send('Target.activateTarget', { targetId: cur.targetId });
    await S('Page.bringToFront');
    return { ok: true, tab: i };
  },
  async cw(q, body) {
    const req = q.get('req') || 'records';
    const extra = body ? JSON.parse(body) : {};
    return evalJs(`
      const id = Math.random();
      return await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no answer from the extension bridge (reload the page?)')), 3000);
        addEventListener('message', function h(e) {
          if (!e.data || e.data.id !== id || !('cwRes' in e.data)) return;
          removeEventListener('message', h); clearTimeout(t); resolve(e.data.out);
        });
        postMessage(Object.assign({ cwReq: ${JSON.stringify(req)}, id }, ${JSON.stringify(extra)}), '*');
      });
    `);
  },
  async logs() { return logs.slice(-100); },
  async reload() {
    const done = loaded(cur.session);
    await S('Page.reload', {});
    await done;
    await waitInteractive();
    return { ok: true };
  },
  async quit() { setTimeout(cleanup, 50); return { ok: true }; },
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.slice(1);
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
    if (!hostOk || req.headers['x-wf-token'] !== TOKEN) {
      req.resume();
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: send x-wf-token (see dev/out/.wf-token)' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      if (!routes[name]) throw new Error(`unknown endpoint /${name}`);
      const out = await routes[name](u.searchParams, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  })
  .listen(HTTP_PORT, '127.0.0.1');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(TOKEN_FILE, TOKEN);

if (START_URL) {
  await nav(START_URL);
  if (/^https:\/\/www\.nytimes\.com\//.test(START_URL)) {
    await evalJs(`localStorage.setItem('cw-test-bridge', '1')`);
    await routes.reload();
  }
}
console.log(`ready: http://127.0.0.1:${HTTP_PORT}  (profile ${profile}, ${path.basename(BIN)} ${version.Browser})`);
