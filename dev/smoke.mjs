#!/usr/bin/env node
// End-to-end smoke test against the real NYT Connections page in Waterfox.
//
// Starts its own harness (dev/wf.mjs: throwaway profile, extension loaded
// from extension/) on a separate port, plays today's puzzle with scripted
// guesses built from NYT's published answers, and checks the things that
// can only be checked on the real site: toolbar placement, guess recording
// (one away, already guessed, tile replicas), two tabs on one puzzle,
// leaving mid-game, exact finish time, results screen, history panel,
// debug-menu check, export/import, and the phone layout.
//
//   node dev/smoke.mjs [--headed] [--port 9340]
//
// Exit code 0 = everything passed. Takes about two minutes. Uses today's
// puzzle, logged out, in a fresh profile — never your own account.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dev', 'out');
const args = process.argv.slice(2);
const PORT = +(args.includes('--port') ? args[args.indexOf('--port') + 1] : 9340);
const HEADED = args.includes('--headed');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Start the harness -----------------------------------------------------
const wfArgs = [path.join(ROOT, 'dev', 'wf.mjs'), '--port', String(PORT)];
if (!HEADED) wfArgs.push('--headless');
const wf = spawn(process.execPath, wfArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
let wfOut = '';
wf.stdout.on('data', (d) => (wfOut += d));
wf.stderr.on('data', (d) => (wfOut += d));
const t0 = Date.now();
while (!/ready:/.test(wfOut)) {
  if (Date.now() - t0 > 90000 || wf.exitCode !== null) {
    console.error(`harness did not start:\n${wfOut}`);
    process.exit(2);
  }
  await sleep(250);
}
const TOKEN = fs.readFileSync(path.join(OUT, `.wf-token-${PORT}`), 'utf8').trim();

async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-wf-token': TOKEN },
    body,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${route}: ${j.error}`);
  return j;
}
const ev = (js) => api('eval', js);
const q = encodeURIComponent;
const click = (sel, text) => api(`click?sel=${q(sel)}${text ? `&text=${q(text)}` : ''}`);
const records = () => api('cw?req=records');
async function waitFor(fn, ms = 8000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

const CARD = '[data-testid="card-label"]';
// The puzzle's own date as NYT prints it above the board (like the
// extension's pageDate); the computer's date can differ around midnight.
const today = () => ev(`
  const M = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const el = document.querySelector('.pz-game-date');
  const m = el && el.textContent.trim().match(/^([A-Za-z]+)\\s+(\\d{1,2}),\\s*(\\d{4})$/);
  if (m && M.includes(m[1].toLowerCase()))
    return m[3] + '-' + String(M.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0') + '-' + m[2].padStart(2, '0');
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');`);
const liveRecord = async () => {
  const st = await api('cw?req=state');
  return (await records()).find((e) => e.id === st.puzzleEntry) || null;
};
async function guess(words, { settle = 3500 } = {}) {
  await click('button', 'Deselect All').catch(() => {});
  await sleep(200);
  for (const w of words) {
    await click(CARD, w);
    await sleep(250);
  }
  await click('button', 'Submit');
  await sleep(settle);
}
const barGeometry = () => ev(`
  const bar = document.querySelector('[data-cw-bar]');
  const h2 = document.querySelector('[data-testid="connections-board"] form h2');
  const card = document.querySelector('${CARD}');
  if (!bar || !h2) return null;
  const b = bar.getBoundingClientRect(), h = h2.getBoundingClientRect();
  const grid = card ? card.parentElement.getBoundingClientRect() : null;
  return { barTop: b.top, barBottom: b.bottom, barMid: b.top + b.height / 2, barRight: b.right,
    h2Top: h.top, h2Mid: h.top + h.height / 2, gridRight: grid && grid.right,
    inForm: !!bar.closest('[data-testid="connections-board"] form'),
    stacked: bar.hasAttribute('data-stack') };`);

let failedEarly = null;
try {
  // --- Board ready ----------------------------------------------------------
  const n = await waitFor(() => ev(`return document.querySelectorAll('${CARD}').length`), 20000);
  check('board loaded with 16 tiles', n === 16, `${n} tiles`);
  const vis = await ev('return document.visibilityState');
  check('page is visible (timers not throttled)', vis === 'visible', vis);
  const date = await today();
  const answers = await ev(`const j = await (await fetch('/svc/connections/v2/${date}.json')).json();
    return j.categories.map((c) => c.cards.map((x) => x.content));`);
  const [g0, g1, g2, g3] = answers;
  const onBoard = await ev(`return [...document.querySelectorAll('${CARD} input')].map((i) => i.value.toUpperCase())`);
  const fromAnswers = answers.flat().map((w) => w.toUpperCase());
  check(`answers fetched for the puzzle on the board (${date})`,
    onBoard.length === 16 && onBoard.every((w) => fromAnswers.includes(w)),
    `board: ${onBoard.slice(0, 4).join(', ')}…  answers: ${fromAnswers.slice(0, 4).join(', ')}…`);

  // --- Toolbar --------------------------------------------------------------
  const geo = await waitFor(barGeometry, 8000);
  check('toolbar lives inside the board form', geo && geo.inForm);
  check('toolbar centered on the heading row',
    geo && Math.abs(geo.barMid - geo.h2Mid) <= 1, geo && `bar ${geo.barMid} vs heading ${geo.h2Mid}`);
  check('toolbar right-aligned with the grid',
    geo && Math.abs(geo.barRight - geo.gridRight) <= 2, geo && `${geo.barRight} vs ${geo.gridRight}`);

  // --- One away, already guessed, replica tiles ----------------------------
  await ev(`window.__toasts = [];
    new MutationObserver((ms) => { for (const m of ms) for (const nd of m.addedNodes)
      if (nd.nodeType === 1 && nd.matches && nd.matches('[data-testid="connection-toast"]'))
        window.__toasts.push(nd.textContent.trim()); })
      .observe(document.body, { childList: true, subtree: true }); return 1;`);
  const oneAway = [g0[0], g0[1], g0[2], g1[0]];
  await guess(oneAway);
  let rec = await liveRecord();
  check('one-away guess recorded and flagged',
    rec && rec.guesses && rec.guesses.length === 1 && rec.guesses[0][0].oneAway === true,
    rec ? `${(rec.guesses || []).length} guesses` : 'no record');
  const tileSize = await ev(`const r = document.querySelector('${CARD}').getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];`);
  const snapCss = rec && (rec.css || []).join(' ');
  check('replica tile stores the real tile size',
    !!snapCss && snapCss.includes(`width:${tileSize[0]}px`) && snapCss.includes(`height:${tileSize[1]}px`),
    `tile ${tileSize.join('x')}`);
  await guess(oneAway);
  rec = await liveRecord();
  const toasts = await ev('return window.__toasts');
  check('"Already guessed" repeat not recorded',
    rec && rec.guesses.length === 1 && toasts.some((t) => /already guessed/i.test(t)),
    `toasts: ${toasts.join(' / ')}`);

  // --- Correct guess: toolbar doesn't move ----------------------------------
  const before = await barGeometry();
  await guess(g0);
  const after = await barGeometry();
  check('toolbar stays put when a group is solved',
    before && after && Math.abs(before.barTop - after.barTop) <= 1, `${before?.barTop} -> ${after?.barTop}`);

  // --- Two tabs on the same puzzle ------------------------------------------
  await api(`newtab?url=${q('https://www.nytimes.com/games/connections')}`);
  await waitFor(() => ev(`return document.querySelectorAll('${CARD}').length > 0`), 15000);
  await sleep(1500);
  await api('tab?i=0');
  await guess(g1);
  await api('tab?i=1');
  await sleep(12000); // tab 1 is visible now and saves every ~5s
  const fromTab1 = (await records()).find((e) => e.d === date);
  const has = (r, words) => r && (r.guesses || []).some((g) =>
    words.every((w) => g.some((x) => String(x.t).toUpperCase() === w.toUpperCase())));
  check('other tab keeps this tab\'s guesses (same puzzle)', has(fromTab1, g1),
    fromTab1 ? `${fromTab1.guesses.length} guesses seen from tab 1` : 'no record');
  await api(`nav?url=${q('about:blank')}`);
  await api('tab?i=0');
  await sleep(500);

  // --- Leaving mid-game doesn't mark the puzzle finished --------------------
  const wrong = [g2[0], g2[1], g3[0], g3[1]];
  await guess(wrong, { settle: 300 });
  const removedAt = await ev(`document.querySelector('[data-testid="connections-board"]').remove();
    return Date.now();`);
  await sleep(3000);
  rec = await liveRecord();
  check('leaving mid-game: not marked finished', rec && !rec.completed,
    rec && rec.completed ? `completed at ${rec.completed}` : '');
  await api(`nav?url=${q('https://www.nytimes.com/games/connections')}`);
  await waitFor(() => ev(`return document.querySelectorAll('${CARD}').length === 8`), 15000);
  await sleep(1500);

  // --- Finish: clock stops at the final Submit ------------------------------
  await ev(`window.__submitAt = 0;
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (b && /submit/i.test(b.textContent)) window.__submitAt = Date.now();
    }, true); return 1;`);
  await guess(g2);
  await guess(g3, { settle: 6000 });
  const submitAt = await ev('return window.__submitAt');
  rec = (await records()).find((e) => e.d === date);
  check('finish time = the final Submit click',
    rec && rec.completed && Math.abs(rec.completed - submitAt) < 150,
    rec && rec.completed ? `${rec.completed - submitAt}ms from the click` : 'not completed');
  const gs = (rec && rec.guesses) || [];
  const uniform = gs.filter((g) => g.length === 4 && g.every((x) => x.correct && x.correct === g[0].correct)).length;
  check('guesses colored: 4 groups + 2 mistakes', uniform === 4 && gs.length === 6,
    `${uniform} solved of ${gs.length} guesses`);

  // --- Results screen covers the toolbar ------------------------------------
  const covered = await ev(`const b = document.querySelector('[data-cw-bar]');
    if (!b || !b.isConnected) return 'gone';
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el && el.closest('[data-cw-bar]') ? 'visible' : 'covered';`);
  check('results screen covers the toolbar', covered !== 'visible', covered);

  // Close NYT's end-of-game screens: its prompts (badge preview after a
  // perfect solve, sign-up/login prompt otherwise — both have
  // data-testid="close-…" close buttons; the page's many "Close … menu"
  // buttons don't), then the results screen ("Back to puzzle"). Nothing
  // inside the prompts is touched — the login prompt can contain a
  // human-verification check.
  const PROMPT_CLOSE = 'button[data-testid^="close-"]';
  const visibleBtn = (sel, text) => ev(`return [...document.querySelectorAll(${JSON.stringify(sel)})]
    .some((b) => b.offsetParent && (${JSON.stringify(text)} === null || b.textContent.trim() === ${JSON.stringify(text)}));`);
  for (let i = 0; i < 3; i++) {
    if (!(await waitFor(() => visibleBtn(PROMPT_CLOSE, null), i ? 1500 : 5000))) break;
    await ev(`const b = [...document.querySelectorAll(${JSON.stringify(PROMPT_CLOSE)})].find((x) => x.offsetParent);
      if (b) b.click(); return 1;`);
    await sleep(1000);
  }
  if (await waitFor(() => visibleBtn('button', 'Back to puzzle'), 5000)) {
    await click('button', 'Back to puzzle');
    await sleep(1000);
  }

  // --- History panel ----------------------------------------------------------
  const atBtn = await ev(`const b = document.querySelector('[data-cw-history-btn]');
    if (!b || !b.isConnected) return 'no History button';
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el && el.closest('[data-cw-history-btn]') ? 'clear'
      : 'covered by ' + (el ? el.tagName + '.' + String(el.className).slice(0, 50) : 'nothing (offscreen?)') + ' at y=' + Math.round(r.top);`);
  if (atBtn !== 'clear') {
    await api('shot?out=smoke-history.png');
    console.log(`      (History button ${atBtn}; screenshot dev/out/smoke-history.png)`);
  }
  await click('[data-cw-history-btn]');
  await sleep(500);
  const panel = await ev(`const p = document.querySelector('[data-cw-history-panel]');
    if (!p) return null;
    const row = p.querySelector('[data-cw-hist-row].current') || p.querySelector('[data-cw-hist-row]');
    return { result: row && row.querySelector('.result') ? row.querySelector('.result').textContent : '',
      stats: (p.querySelector('.stats') || {}).textContent || '',
      checkVisible: [...p.querySelectorAll('button')].some((b) => /check/i.test(b.textContent)) };`);
  check('history row shows the result', panel && /2 mistakes/.test(panel.result), panel && panel.result);
  check('history shows stats', panel && /played/i.test(panel.stats), panel && panel.stats);
  check('check button hidden until the debug menu is opened', panel && !panel.checkVisible);

  await click('[data-cw-history-panel] .dbg-toggle');
  await sleep(300);
  await click('[data-cw-history-panel] .debug button', 'check history');
  const status = await waitFor(async () => {
    const s = await ev(`return (document.querySelector('[data-cw-history-panel] .status') || {}).textContent || ''`);
    return /Checking/.test(s) ? '' : s;
  }, 20000, 500);
  check('debug menu: check history runs', /checked/.test(status || ''), status);

  // The harness is signed out, so NYT refuses the saved-progress request:
  // the import must say so and add nothing.
  const recsBefore = (await records()).length;
  await click('[data-cw-history-panel] .debug button', 'import from NYT');
  const impStatus = await waitFor(async () => {
    const s = await ev(`return (document.querySelector('[data-cw-history-panel] .status') || {}).textContent || ''`);
    return /Importing/.test(s) ? '' : s;
  }, 20000, 500);
  const recsAfter = (await records()).length;
  check('import from NYT while signed out asks to sign in',
    /sign in/i.test(impStatus || '') && recsAfter === recsBefore, `${impStatus} (${recsBefore} -> ${recsAfter} records)`);

  // --- Export / import -------------------------------------------------------
  const exportFile = path.join(OUT, `connextras-history-${date}.json`);
  fs.rmSync(exportFile, { force: true });
  await click('[data-cw-history-panel] .tools button', 'export');
  const exported = await waitFor(() => fs.existsSync(exportFile) && fs.statSync(exportFile).size > 0, 8000);
  const nRecords = (await records()).length;
  let exportedCount = -1;
  try {
    exportedCount = JSON.parse(fs.readFileSync(exportFile, 'utf8')).records.length;
  } catch (_) {}
  check('export writes every record to a file', exported && exportedCount === nRecords,
    `${exportedCount} in file, ${nRecords} stored`);
  if (exported) {
    await api(`setfiles?sel=${q('[data-cw-import]')}&path=${q(path.relative(ROOT, exportFile))}`);
    await sleep(1000);
    const st = await ev(`return (document.querySelector('[data-cw-history-panel] .status') || {}).textContent || ''`);
    check('re-importing the export changes nothing', /0 added, 0 updated/.test(st), st);
  }
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`);

  // --- Phone layout -------------------------------------------------------------
  await api('viewport?w=390&h=844');
  await sleep(800);
  const phone = await barGeometry();
  check('phone width: toolbar gets its own row above the heading',
    phone && phone.stacked && phone.barBottom <= phone.h2Top + 1,
    phone && `bar bottom ${phone.barBottom}, heading top ${phone.h2Top}`);
  await api('viewport?w=1400&h=1000');
} catch (err) {
  failedEarly = err;
  check('smoke test ran to the end', false, String(err && err.message || err));
}

// --- Static: the test bridge must not ship ---------------------------------------
const src = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');
const starts = (src.match(/@dev-only:start/g) || []).length;
const ends = (src.match(/@dev-only:end/g) || []).length;
const outside = src.replace(/\/\/ @dev-only:start[\s\S]*?\/\/ @dev-only:end/g, '');
check('test bridge only inside @dev-only markers',
  starts === 1 && ends === 1 && !/cw-test-bridge/.test(outside));

try {
  await api('quit');
} catch (_) {}
await sleep(2000);
try {
  wf.kill();
} catch (_) {}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
