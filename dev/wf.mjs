#!/usr/bin/env node
// Waterfox test driver for the extension.
//
// Launches Waterfox with a brand-new throwaway profile (no NYT login, no
// history, nothing shared with your normal profile; deleted on exit),
// installs extension/ as a temporary add-on over WebDriver BiDi, and serves
// a tiny HTTP API on 127.0.0.1 so scripts (or curl) can drive it.
//
//   node dev/wf.mjs [--headless] [--port 9333] [--url <start url>]
//                   [--seed <dir>]
//
// --seed copies <dir>'s contents into the fresh profile before launch
// (e.g. a storage/default/<origin> folder, to test against real site data).
//
// Endpoints (all GET unless noted; responses are JSON):
//   /nav?url=...            navigate the tab and wait for load
//   POST /eval              body = JS function body (may use await/return);
//                           runs in the page, returns the JSON result
//   /click?sel=...&i=0[&text=WORD]  real mouse click on the i-th match of a
//                           selector (optionally only elements containing text)
//   /click?x=..&y=..        real mouse click at viewport coordinates
//   /key?k=Escape           press a key
//   /shot?out=file.png[&sel=...]   screenshot (viewport, or one element)
//   /viewport?w=390&h=844   resize the page viewport (default 1400x1000)
//   /newtab?url=..          open another tab and make it current; /tab?i=0
//                           switches back (every command acts on the current tab)
//   /cw?req=records|state|clear  read/clear history via the extension's test
//                           bridge; POST /cw?req=put with {"records": [...]}
//   /setfiles?sel=..&path=..  give a file to an <input type=file>
//   (downloads, e.g. history export, are saved straight to dev/out/)
//   /reload                 reinstall the extension from disk + reload page
//   /quit                   close Waterfox and delete the profile
//
// Every request needs the header  x-wf-token: <token>. The token is random
// per run and written to dev/out/.wf-token, e.g.
//   curl -H "x-wf-token: $(cat dev/out/.wf-token)" 127.0.0.1:9333/key?k=Escape
// Without it, any web page open in another browser could drive this one
// (or write files via /shot) by sending requests to localhost.
//
// Waterfox path: $WATERFOX, else C:\Program Files\Waterfox\waterfox.exe.

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

const BIN = process.env.WATERFOX || 'C:\\Program Files\\Waterfox\\waterfox.exe';
const HTTP_PORT = +opt('--port', 9333);
const BIDI_PORT = HTTP_PORT + 1;
const START_URL = opt('--url', 'https://www.nytimes.com/games/connections');
const OUT_DIR = path.join(ROOT, 'dev', 'out');
const TOKEN = crypto.randomBytes(16).toString('hex');
// The default port's token is dev/out/.wf-token; other ports (e.g. the
// smoke test's own instance) get .wf-token-<port>, so both can run at once.
const TOKEN_FILE = path.join(OUT_DIR, HTTP_PORT === 9333 ? '.wf-token' : `.wf-token-${HTTP_PORT}`);

// --- Fresh profile ---
// Sweep profiles left by earlier runs (Waterfox can still hold files for a
// few seconds after exit, so the delete-on-exit sometimes loses the race).
for (const d of fs.readdirSync(os.tmpdir())) {
  if (!d.startsWith('cw-waterfox-')) continue;
  try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch (_) {}
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-waterfox-'));
fs.writeFileSync(
  path.join(profile, 'user.js'),
  [
    ['browser.shell.checkDefaultBrowser', false],
    ['browser.startup.homepage_override.mstone', 'ignore'],
    ['browser.aboutwelcome.enabled', false],
    ['startup.homepage_welcome_url', ''],
    ['browser.startup.page', 0],
    ['datareporting.policy.dataSubmissionEnabled', false],
    ['toolkit.telemetry.reportingpolicy.firstRun', false],
    ['xpinstall.signatures.required', false],
    ['app.update.enabled', false],
    ['app.update.auto', false],
    // Downloads (e.g. history export) go straight to dev/out/, no dialog.
    ['browser.download.folderList', 2],
    ['browser.download.dir', OUT_DIR],
    ['browser.download.useDownloadDir', true],
    ['browser.download.always_ask_before_handling_new_types', false],
    ['browser.download.start_downloads_in_tmp_dir', false],
    ['browser.download.alwaysOpenPanel', false],
  ]
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n')
);

if (opt('--seed')) fs.cpSync(path.resolve(opt('--seed')), profile, { recursive: true });

const wfArgs = [
  // -wait-for-browser: on Windows the launcher process otherwise exits
  // immediately after handing off to the real browser process.
  '-profile', profile, '-no-remote', '-new-instance', '-wait-for-browser',
  `--remote-debugging-port=${BIDI_PORT}`,
];
if (flag('--headless')) wfArgs.push('--headless');
const wf = spawn(BIN, wfArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let send = null; // BiDi command sender, once connected
const cleanup = async () => {
  // Ask the browser to close itself: killing the launcher alone leaves the
  // real browser process running (and holding the BiDi port).
  try { if (send) await Promise.race([send('browser.close'), new Promise((r) => setTimeout(r, 3000))]); } catch (_) {}
  try { wf.kill(); } catch (_) {}
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch (_) {}
  // Give the process a moment to release file locks before deleting.
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (_) {}
    process.exit(0);
  }, 1500);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
wf.on('exit', (code) => {
  console.log(`waterfox exited (${code})`);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (_) {}
  process.exit(0);
});

const wsUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Waterfox did not open BiDi in 30s')), 30000);
  const onData = (buf) => {
    const m = String(buf).match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  };
  wf.stderr.on('data', onData);
  wf.stdout.on('data', onData);
});

// --- BiDi client ---
const ws = new WebSocket(`${wsUrl.replace(/\/$/, '')}/session`);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === 'error') reject(new Error(`${msg.error}: ${msg.message}`));
    else resolve(msg.result);
  } else if (msg.method === 'log.entryAdded') {
    const p = msg.params;
    logs.push(`[${p.level}] ${p.text}`);
    if (logs.length > 300) logs.shift();
  }
};
send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
await send('session.subscribe', { events: ['log.entryAdded'] });

let extId = null;
async function installExt() {
  if (extId) {
    try { await send('webExtension.uninstall', { extension: extId }); } catch (_) {}
  }
  const r = await send('webExtension.install', {
    extensionData: { type: 'path', path: EXT },
  });
  extId = r.extension;
}
await installExt();

const tree = await send('browsingContext.getTree', {});
// Commands act on the current tab; /newtab and /tab switch it.
const tabs = [tree.contexts[0].context];
let ctx = tabs[0];
await send('browsingContext.setViewport', { context: ctx, viewport: { width: 1400, height: 1000 } });

// "Loaded" isn't "playable": NYT's React app attaches its event handlers
// (hydrates) a moment after the load event, and clicks before that are
// lost. On a Connections page, wait until React owns the board (its
// elements get __reactProps… keys), then a short settle.
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
const nav = async (url) => {
  const r = await send('browsingContext.navigate', { context: ctx, url, wait: 'complete' });
  await waitInteractive();
  return r;
};

async function evalJs(body) {
  const expression = `(async () => { ${body}\n})().then(v => JSON.stringify(v === undefined ? null : v))`;
  const r = await send('script.evaluate', {
    expression,
    target: { context: ctx },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
  return JSON.parse(r.result.value);
}

async function clickAt(x, y) {
  await send('input.performActions', {
    context: ctx,
    actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 40 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
}

// JS (as a string) that finds the i-th element matching a selector and,
// optionally, a text. An exact match wins (the element's text, one of its
// children's, an inner input's value, or its aria-label — NYT tiles hold
// the word twice), so "CUT" never hits a "CUTE" tile; "contains" is only a
// fallback.
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

// Click an element itself rather than coordinates measured earlier: the
// pointer moves to the element's center when the click is performed, so a
// layout shift in between (NYT's promo banner pushes the page down ~45px
// shortly after load) can't make it land on the wrong tile. Waits briefly
// for the element to stop moving first.
async function clickElement(sel, i = 0, text = null) {
  // The element may be briefly missing while the page re-renders (NYT
  // remounts the board when its intro screen hands over): wait up to 5s.
  const found = await evalJs(`
    let el = null;
    for (let n = 0; n < 50 && !(el = ${findJs(sel, i, text)}); n++)
      await new Promise((res) => setTimeout(res, 100));
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest' });
    let last = '';
    for (let n = 0; n < 20; n++) {
      const r = el.getBoundingClientRect();
      const now = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
      if (now === last) return true;
      last = now;
      await new Promise((res) => setTimeout(res, 100));
    }
    return true;
  `);
  if (!found) throw new Error(`no element for ${sel} ${text || ''} (waited 5s)`);
  const r = await send('script.evaluate', {
    expression: findJs(sel, i, text),
    target: { context: ctx },
    awaitPromise: false,
    resultOwnership: 'root',
  });
  if (r.type === 'exception' || r.result.type !== 'node')
    throw new Error(`element for ${sel} ${text || ''} vanished before the click (${r.type === 'exception' ? r.exceptionDetails.text : r.result.type})`);
  await send('input.performActions', {
    context: ctx,
    actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: r.result.sharedId } } },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 40 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
}

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
    await clickAt(x, y);
    return { ok: true, x, y };
  },
  async key(q) {
    const k = q.get('k');
    const map = { Escape: '\uE00C', Enter: '\uE007', ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015' };
    const v = map[k] || k;
    await send('input.performActions', {
      context: ctx,
      actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }] }],
    });
    return { ok: true };
  },
  async shot(q) {
    const params = { context: ctx };
    if (q.get('sel')) {
      const r = await rectOf(q.get('sel'), q.get('i') || 0);
      if (!r) throw new Error(`no element for ${q.get('sel')}`);
      params.clip = { type: 'box', ...r };
    }
    const { data } = await send('browsingContext.captureScreenshot', params);
    // Screenshots only ever land in dev/out/ (a bare name or dev/out/x.png).
    const name = path.basename(q.get('out') || 'shot.png');
    if (!/^[\w.-]+\.png$/i.test(name)) throw new Error('out must be a .png file name');
    const out = path.join(OUT_DIR, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    return { ok: true, out };
  },
  async viewport(q) {
    const viewport = { width: +q.get('w') || 1400, height: +q.get('h') || 1000 };
    await send('browsingContext.setViewport', { context: ctx, viewport });
    return { ok: true, viewport };
  },
  // Give a file to an <input type=file> (no picker dialog), firing change.
  async setfiles(q) {
    const r = await send('script.evaluate', {
      expression: `document.querySelector(${JSON.stringify(q.get('sel'))})`,
      target: { context: ctx },
      awaitPromise: false,
      resultOwnership: 'root',
    });
    if (r.type === 'exception' || r.result.type !== 'node') throw new Error(`no element for ${q.get('sel')}`);
    const file = path.resolve(ROOT, q.get('path'));
    await send('input.setFiles', { context: ctx, element: { sharedId: r.result.sharedId }, files: [file] });
    return { ok: true, file };
  },
  async newtab(q) {
    const r = await send('browsingContext.create', { type: 'tab' });
    tabs.push(r.context);
    ctx = r.context;
    await send('browsingContext.setViewport', { context: ctx, viewport: { width: 1400, height: 1000 } });
    if (q.get('url')) await nav(q.get('url'));
    return { ok: true, tab: tabs.length - 1 };
  },
  async tab(q) {
    const i = +q.get('i') || 0;
    if (!tabs[i]) throw new Error(`no tab ${i}`);
    ctx = tabs[i];
    await send('browsingContext.activate', { context: ctx });
    return { ok: true, tab: i };
  },
  // History lives in extension storage; this asks the extension's test
  // bridge for it (req=records|state|clear, or POST {records} with req=put).
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
    await installExt();
    await send('browsingContext.reload', { context: ctx, wait: 'complete' });
    await waitInteractive();
    return { ok: true, ext: extId };
  },
  async quit() { setTimeout(cleanup, 50); return { ok: true }; },
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.slice(1);
    // Host check blocks DNS-rebinding pages; the token blocks everything else
    // (a cross-site page can neither read the token nor send a custom header
    // without a CORS preflight, which this server never answers).
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
  // Turn on the extension's test bridge for this throwaway profile (see
  // /cw), then reload so the content script picks it up.
  if (/^https:\/\/www\.nytimes\.com\//.test(START_URL)) {
    await evalJs(`localStorage.setItem('cw-test-bridge', '1')`);
    await send('browsingContext.reload', { context: ctx, wait: 'complete' });
    await waitInteractive();
  }
}
console.log(`ready: http://127.0.0.1:${HTTP_PORT}  (profile ${profile})`);
