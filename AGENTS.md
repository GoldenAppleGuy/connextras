# Connextras

Browser extension (MV3; Firefox, and Chrome/Edge from one source) that adds drag-to-reorder, right-drag color tags,
arrow-key reordering, Ctrl+Z undo, a persistent puzzle clock, a puzzle-time
history panel, and a dark-mode toggle to NYT Connections.

## Layout

- `extension/` — the unpacked extension (`manifest.json`, `content.js`,
  `content.css`, `icon-{48,96,128}.png`)
- `dev/harness.html` — offline mock of the Connections board for testing
- `dev/icon.svg` — icon source (render the PNGs with headless Edge/Chrome
  `--screenshot`, transparent background)
- `dev/amo-listing.md`, `dev/chrome-listing.md`, `dev/listing/` — store
  listing text (addons.mozilla.org; Chrome Web Store / Edge Add-ons)
  and screenshots (1280×800, taken on the live site via `dev/wf.mjs`)
- `build.py` — packages `extension/` into `connextras-<version>.xpi`
  (Firefox) and `connextras-<version>-chrome.zip` (Chrome/Edge)
- `dev/wf.mjs` / `dev/cr.mjs` — live test drivers for Waterfox / Chromium
- `*.xpi` — built add-on packages
- `README.md`, `LICENSE` (MIT)

Add-on id: `connextras@goldenappleguy` (Connextras 1.0.0 on; the earlier
"Connections Rearranger" builds, up to 1.14.0, used
`connections-rearranger@local`). Never change it again: AMO keys updates
on it, and extension storage (the whole history) belongs to it. Run
`npx web-ext lint --source-dir <unzipped .xpi>` before each AMO upload.

## How it works

- All input is intercepted on `window` in the capture phase, before the game
  sees it. A press that moves <6px is replayed as a normal click; a real drag
  is swallowed entirely.
- Reordering sets CSS `order` on the grid items — DOM nodes are never moved,
  so React never notices.
- Tile identity (`keyOf`) prefers DOM ids (`label[for]` / inner `input[id]`),
  then `aria-label`, `img[alt]`, then text. Never key order/tags by
  `textContent` alone — picture/emoji puzzles have no usable text.

## Controls

- Drag a tile onto another to swap them; hold right-click on a tile and flick
  into a quadrant to color-tag it (plain right-click clears); hover + keys
  1-4 tags, 0 clears.
- Arrow keys swap the *selected* tile with its visual neighbor (or the
  hovered tile when 0 or 2+ are selected); Ctrl+Z undoes the last
  reorder/tag (stack of 50).
- Everything is kept per puzzle in the history store (see "History
  store"): `{id, tiles, words, tags, ms, u, d, started, completed, guesses,
  css}` — visual order (as tile texts), tag map, accumulated time, puzzle
  date, and guesses all persist and restore across visits.

## Debugging

- `localStorage.setItem('cw-debug','1')` then reload (or append `?cwdebug` to
  the URL): enables `[CW]` console logs and an on-page HUD showing the matched
  selector, tile keys, current order, tags, clock, and recent events.
- `window.__cw` is always available in the console: `__cw.cards()`,
  `__cw.keys()`, `__cw.order()`, `__cw.tags()`, `__cw.events()`,
  `__cw.times()`, `__cw.ready()`, `__cw.clock()` (clock internals),
  `__cw.resetClock()`, `__cw.putRecords(list)`,
  `__cw.deleteRecord(id)`, `__cw.clearRecords()`, `__cw.importRecords(data)`,
  `__cw.undo()`, `__cw.move(card, dir)`,
  `__cw.tag(card, color)`, `__cw.setHidden(bool)`, `__cw.history()`,
  `__cw.debug(true/false)`.

## Dev harness

Open `dev/harness.html` in a browser (or serve the repo root and open
`/dev/harness.html`). It loads the real `extension/content.js`/`content.css`
against a mock board.

- Variant selector: normal words, emoji text tiles, `<img>` tiles with
  alt/aria labels, and image tiles with no `for`/`id` (worst-case keying).
- `?v=<variant>` picks the variant at load; `?selftest` auto-runs the
  scripted test (synthetic pointer events for click/drag/tag/shuffle/clock/
  dark toggle), results render in the right-hand panel.
- "native dark CSS" checkbox: when on, the page mimics NYT's own
  `body[data-mode=dark]` dark palette; when off, the extension's adaptive
  fallback overrides should engage instead.

Headless run (Chrome/Edge):

```
chrome --headless=new --virtual-time-budget=20000 --dump-dom \
  "file:///.../dev/harness.html?selftest&v=images-noid"
```

## Clock

The toolbar (clock, History, dark toggle) is a child of the board, not a
floating overlay: `ensureUi`/`placeBar` append it to NYT's
`[data-testid="connections-board"] form` (which holds the "Create four
groups of four!" `h2` and the grid, both while playing and when finished)
and center it on the heading row, right-aligned with the grid. If it would
run into the heading text (narrow screens) it stacks above the heading and
the form gets `margin-top` for that row. Without that form (dev harness)
it sits above the top-right corner of the grid's wrapper. It therefore
scrolls, shows, hides and gets covered with the board — never position it
with timers or overlap checks. A finished puzzle with no tiles shows its
recorded time.

The clock starts when the board appears, freezes when it empties (solved/navigated
away), resets on a new board. Click the clock to hide it (persisted in
`localStorage['cw-clock']`); the small `◷` restore button brings it back.

When the tiles disappear: if the board is still on the page the game is
over — the clock stops at the Submit that ended it (`lastSubmitAt`, not
when the board finished emptying) and the record gets `completed`. If the
board is gone too (navigated away mid-game), the clock stops when the tiles
vanished and the record is *not* marked completed.

Elapsed time accumulates per puzzle in the history store. A record is
identified by its puzzle date `d` (`puzzleDate`: the URL for archives,
then NYT's `.pz-game-date` heading, then the computer's date); tile-text
overlap only confirms it. Never match on overlap alone — different puzzles
share words (e.g. VIDEO GAME on 2026-03-04 and 2026-03-09). If a different
puzzle replaces the board in place, `puzzleChanged` re-resolves it (tile
keys are positional `inner-card-N`, so stale tags would otherwise carry).

### History store

- Unlimited: one record per key `rec:<id>` in `browser.storage.local`
  (manifest: `storage` + `unlimitedStorage`). Not visible to the site.
  Deleted if the add-on is uninstalled (updates keep it) — export first.
- Reads are synchronous from an in-memory `mirror` loaded at startup;
  nothing that needs records runs before `storeReady` (`resolvePuzzle`,
  `tickClock`). `writeTimes(entry)` writes only that record's key.
- Other tabs' changes arrive via `storage.onChanged` (`onStoreChange`).
  For the puzzle being played here they are merged (`mergeIntoLive`:
  union of guesses, colors, tiles; larger time) and saved only if
  something changed — otherwise two tabs on the same puzzle erase each
  other's guesses. Exception: "reset clock" (debug menu, `resetClock`,
  shown while a puzzle is unfinished) sets `ms: 0` and stamps
  `clockReset`; a record with a newer `clockReset` is followed, and times
  from before the newest reset are never merged back in.
- Pre-1.9 history (`localStorage['cw-times']`, capped at 60) is left as
  is and copied in by `migrateLegacy` on every load, one record at a time:
  copied ids are kept in `meta:migratedIds` (so deleted records never come
  back), and a puzzle date already in the store keeps its record. Never a
  one-shot flag: a private window sees empty page storage but shares
  extension storage, so a flag set there ended 1.9.0's migration for good.
- Tile snapshots keep each distinct inline style once per record
  (`e.css`), referenced as `data-cs="<n>"` (`compactSnap`/`expandSnap`).
- Without extension storage (dev/harness.html) the same keys live in
  localStorage as `cw-rec:<id>` / `cw-meta:...`.
- Results are derived, not stored: `resultOf` (4 correct groups = won, 4
  wrong guesses = lost, once all guessed tiles have colors) feeds the row
  labels and `historyStats` (played, win %, perfect, avg/best winning
  time, streak = wins in a row in the order puzzles were finished — not by
  puzzle date, since archive puzzles are played out of order).
  Order counters: purple first (first guess was the purple group),
  rev. rainbow (groups solved purple, blue, green, yellow; mistakes in
  between ok) and rarest first (first guess was `e.rare`). `fillRare`
  runs on nytimes.com when the panel opens, once per finished puzzle:
  `e.cats` (category names by color from `/svc/connections/v2/<d>.json`,
  also set by the NYT import; finished puzzles only, names reveal
  answers), and for puzzles dated before today, from Connections Bot's
  public `static01.nyt.com/newsgraphics/2024/connections-bot/game/<d>-summary.json`
  (CORS `*`; today's file still changes): `e.first` (`{yellow: 35.3, …}`,
  % of winners who solved each group first, from `firstColor` by level,
  0 = yellow), `e.rare` (its least common entry) and `e.wrong` (`{"A|B|C|D":
  9.1}`: words sorted, % of the `complete` sample of games with that exact
  wrong guess, from `mistakenGuesses` keyed by sorted card positions; the
  list is complete, missing = 0). A correct group shows its category
  name above the tiles (`.cat`) and "first for N%" below; a wrong guess
  shows "One away · made by N%" below.
- "check history" (`checkHistory`) lives in the panel's debug menu (⋯ in
  the header, with the debug-overlay toggle) so it can't be hit by
  accident while solving. It fetches `/svc/connections/v2/<d>.json` for
  each dated record: colors guesses on *finished* records only (never the
  puzzle in progress or one saved unfinished — colors reveal answers) and
  splits guesses that belong to a different puzzle into an undated
  `split: true` "Unknown date" record. Skips records whose tiles mostly
  don't match (picture puzzles). Progress updates only the status line.
- "import from NYT" (`importFromNyt`, same debug menu) rebuilds finished
  puzzles saved to the player's NYT account: it walks puzzle ids down from
  today's (`/svc/connections/v2/<today>.json` gives the id) down to the
  "from" date's id (date field next to the button; defaults to the 1st of
  the month of the oldest non-imported record, empty = all), starting at
  the "to" date's id instead of today's when that field is set, in batches of
  50 via `/svc/games/state/connections/latests?puzzle_ids=` (403 when
  signed out; a 400 splits the batch in half and the smaller size sticks,
  single ids still rejected are skipped, and NYT's error text is shown if
  nothing ever works — `nytStates`), and maps each saved guess (`{cards: "3,7,9,14", correct}`,
  positions into the answers JSON) to `{t, correct}` items. Records get
  `nyt: true`, `ms: 0` (NYT keeps no solve time: shown as "–", left out of
  time stats) and `completed`/`u` = NYT's save timestamp. Dates already in
  history and unfinished puzzles are skipped; "remove NYT imports" deletes
  every `nyt` record. Picture puzzles (no `content`, e.g. 2026-04-01)
  save each tile as `h: '<img src=image_url alt=image_alt_text>'`, drawn
  by `oldTileReplica(text, null, img)` filling a template tile. Only verified against mock data and a signed-out
  session — the signed-in response shape comes from NYT's game code.
- The panel lists every record (no cap); guess tiles build on expand.

Each row's times line starts with the day it was played (`started`,
or `completed` for NYT imports; the finish gets its own day if it differs),
since archive puzzles are often played on another day.
Pauses while the tab is hidden; the History button in the bar opens a
docked right sidebar listing recent puzzles (most recently played first)
with their dates and times; the in-progress puzzle shows a "playing"
badge and the live clock. Dates gain a year when it isn't the current
one. Each row except the puzzle being played has a delete ✕ (with a
confirm popover); `export` downloads `connextras-history-<date>.json`
(`{app: 'connextras', version, exported, records}`; Connections Rearranger's
files said `app: 'connections-rearranger'` and import never checks it) and `import` merges such a file (or
a bare records array) via `importRecords`: keyed by puzzle date, newer `u`
wins, every field rebuilt by `cleanRecord`. Stored tile snapshots are
rendered only through `safeTileNodes` (element/attribute allow-list), never
`innerHTML`, since imported files are untrusted.
Search matches inside one entry of `row.dataset.search` (the date, each
tile, each category name, joined by line breaks), never across two
neighboring tiles.
Re-renders (`renderHistory`) keep the scroll position, search filter
and search focus. Rows link to the archive puzzle at
`/games/connections/<e.d>` and show recorded Submit guesses
(`e.guesses`, captured on each Submit click). Each guess is an array of
4 items `{t, s, w, correct?}`: `s` is a replica of the tile from
`snapshotTile` (same structure, computed layout/typography inlined, colors
left to CSS) and `w` its width, used to zoom it into the history cell.
Older records (before 1.8) hold `{t, h}` or plain strings: text tiles are
drawn inside the box of the newest tile saved in full (or a tile on the
board), with their word and the shrink-to-fit `font-size` from `h`
(`oldTileReplica`). The template is the widest text tile saved or on the
board (`findTileTemplate`; a tile saved in a narrow window would wrap
words), else NYT's desktop tile built in (`NYT_TILE_HTML`: history with
only pre-1.8 records, viewed after the puzzle is finished).
Without a saved size (NYT imports) the font is NYT's own shrink-to-fit
(`nytFitEm`: the text's width, clamped to [longest word, tile width] and
capped at one line; past 90% of the tile it scales by 0.9 × tile / width),
and the text is always centered.
Guess colors come from NYT's solved rows (`tileColors`/`markGuesses`);
its fallback for boards without NYT's testids skips tiles and our own UI,
since color tags paint tiles in the category colors and would otherwise be
saved as answers.
After Submit, `watchToast` reads NYT's `[data-testid="connection-toast"]`:
"One away..." sets `guess[0].oneAway`; "Already guessed!" drops the guess.
`isOneAway` also derives it once all four tiles' categories are known.
Intro screens ("Admire Puzzle", Play) are auto-advanced by
`tryAutoAdvance`, which clicks a play/continue-ish button inside a
dialog once per page load.

## Dark mode

The toggle flips NYT's own dark palette (`body[data-mode="dark"]
.display-settings-enabled`, persisted in `localStorage['nytd:mode']`). If the
page still computes light colors after toggling (dark CSS not present),
`html[data-cw-dark-fallback]` styles in `content.css` take over.

## Live testing in Waterfox (`dev/wf.mjs`; Chromium: see Chrome / Edge)

`node dev/wf.mjs [--headless]` launches Waterfox (`$WATERFOX`, default
`C:\Program Files\Waterfox\waterfox.exe`) with a throwaway profile (no
NYT login; deleted on exit), installs `extension/` as a temporary add-on
over WebDriver BiDi, opens the daily puzzle, and serves an HTTP API on
`127.0.0.1:9333`. Every request needs the header `x-wf-token`, whose
random per-run value is in `dev/out/.wf-token` (and only `Host:
127.0.0.1`/`localhost` is accepted), so other web pages can't drive it:

```
TK=$(cat dev/out/.wf-token)
curl -H "x-wf-token: $TK" "127.0.0.1:9333/click?sel=button&text=Shuffle"
```

- `POST /eval` (body = async JS function body, returns JSON) — runs in the
  page's main world. `window.__cw` and extension storage are NOT visible
  there; use `/cw` for history.
- `/cw?req=records|state|clear` (and `POST /cw?req=put` with
  `{"records": [...]}`) talks to the extension's test bridge, which only
  listens when `localStorage['cw-test-bridge'] === '1'` (the harness sets
  it on its throwaway profile at startup). The bridge sits between
  `// @dev-only:start` / `// @dev-only:end` and `build.py` strips it from
  the `.xpi` — any page script could set that flag, so it must never ship.
- `/newtab?url=` opens a second tab and makes it current, `/tab?i=0`
  switches back; every command acts on the current tab.
- `/nav?url=`, `/click?sel=&text=&i=`, `/click?x=&y=`, `/key?k=`,
  `/shot?out=x.png[&sel=]` (always saved in `dev/out/`), `/reload` (reinstall extension from
  disk + reload page), `/viewport?w=&h=`, `/setfiles?sel=&path=` (hand a
  file to an `<input type=file>`), `/logs`, `/quit` (always quit; it closes
  the browser and deletes the profile). Downloads land in `dev/out/`.
- `--seed <dir>` copies a folder into the fresh profile before launch,
  e.g. a `storage/default/https+++www.nytimes.com` copy to test real data.
- Answers for scripted play: `fetch('/svc/connections/v2/<date>.json')`
  in `/eval`. Screenshots go to `dev/out/` (gitignored).

### Smoke test (`dev/smoke.mjs`)

`node dev/smoke.mjs [--headed]` starts its own headless harness on port
9340 (token `dev/out/.wf-token-9340`, so it can run beside a normal one),
plays today's puzzle from NYT's published answers, and checks ~24 things
that only the real site can show: toolbar placement and stability, one
away / already guessed, replica tile size, two tabs on one puzzle,
leaving mid-game, finish time vs. the final Submit, results screen
covering the toolbar, history result/stats, debug-menu check,
export/import round trip, phone layout, and that the test bridge is only
in `@dev-only` code. Exit code 0 = all passed; ~2 minutes. Run it after
any change to `extension/`. It closes NYT's end-of-game prompts only via
their `button[data-testid^="close-"]` buttons and never touches anything
inside them (the login prompt can contain a human-verification check).

Harness clicks (`/click?sel=`) target the element itself (WebDriver
element origin) after it stops moving, wait up to 5s for it to exist, and
prefer exact word matches ("CUT" never hits "CUTE"). `/nav`, `/reload` and
startup wait until NYT's React app owns the board (`__reactProps` on the
board element) — clicks before that are lost. If a run looks slow, check
`document.visibilityState`: a minimized/hidden test window throttles timers.

## Testing nonstandard puzzles

Archived puzzle **#294 (2024-04-01, all-emoji grid)** and **#660
(2025-04-01, symbol grid)** exercise the image/symbol tile paths; both require
an NYT Games subscription via the Connections archive.

## Build & install

- `python build.py` → `connextras-<version>.xpi` and
  `connextras-<version>-chrome.zip` (drops `@dev-only` blocks; fails on
  unbalanced markers). The Chrome zip's manifest leaves out
  `browser_specific_settings` (Firefox's id and data declaration).
- Dev install, Firefox: `about:debugging` → This Firefox → Load Temporary
  Add-on → pick `extension/manifest.json`. Chrome/Edge: `chrome://extensions`
  (`edge://extensions`) → Developer mode → Load unpacked → `extension/`.

## Chrome / Edge

The same `extension/` runs in Chromium. Browser differences live in two
places in `content.js`: storage (`extStorage`: `browser.storage`, else
`chrome.storage`, else the harness's localStorage) and `pageFetch`
(Firefox's `content.fetch` sends the page's NYT cookies; Chromium's plain
`fetch` already does). Never key anything on `browser` alone, or Chrome
silently falls back to the page's localStorage.

`node dev/cr.mjs [--headless] [--port N]` is `dev/wf.mjs` for Chromium
over the DevTools protocol: same endpoints and token, plus
`/drag?x1=&y1=&x2=&y2=[&button=right]`; `/reload` only reloads the page
(extension files load at launch). Browser: `$CHROME`, else Edge. Branded
Google Chrome 137+ ignores `--load-extension`, so use Edge or Chrome for
Testing. `node dev/smoke.mjs --chrome` runs the smoke test there. NYT
shows Chromium extra promos; the smoke test closes them via their
`close-` buttons like any prompt.
