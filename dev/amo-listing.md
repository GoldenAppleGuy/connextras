# addons.mozilla.org listing

Text to paste into the AMO submission form (Developer Hub → Submit a New
Add-on). Screenshots are in `dev/listing/`.

## Name

Connextras

## Summary (max 250 characters)

Rearrange and color-tag tiles on NYT Connections, undo moves, time your
solves, and keep a history of every puzzle with your guesses, categories,
results and stats. Unofficial.

## Description

Connextras adds the tools NYT Connections leaves out.

**While you solve**
- Drag a tile onto another to swap them, or use the arrow keys. Ctrl+Z undoes.
- Color-tag tiles with your own guesses: hold right-click and flick toward a corner, or hover and press 1–4 (0 clears).
- A puzzle clock that pauses when you switch tabs and stops at your final Submit.
- A dark mode toggle.

**After you solve**
- A history of every puzzle you play: your guesses drawn like NYT's tiles, category names, one-away guesses, result, time and the day you played.
- Stats: played, win %, perfect games, average and best time, streak, purple first, reverse rainbow, and "rarest first".
- How others played, from NYT's public Connections Bot data: how many winners solved each group first, and how many players made each of your wrong guesses.
- Import your finished puzzles from your NYT account (while signed in), for any date range.
- Search, export and import your history.

Everything is stored in your browser only; the add-on has no server and collects no data. Removing the add-on deletes its history, so export it first.

Not made by or affiliated with The New York Times. "Connections" is a game by The New York Times.

## Categories

Games & Entertainment

## Tags

connections, nyt, puzzle, word game, games

## Support

- Support website: https://github.com/GoldenAppleGuy/connextras/issues
- Support email: (optional; leave empty to keep your address private)

## License

MIT

## Privacy policy

Not required: no data is collected or sent anywhere except NYT itself (the
manifest declares `data_collection_permissions: none`). If AMO asks,
summarize the README's Privacy section.

## Notes to reviewer

- Plain, unminified JavaScript; no build step beyond zipping. `build.py`
  packages `extension/` and strips the `// @dev-only` test bridge (used only
  by the local test harness), so the uploaded package has none.
- The content script runs only on `https://www.nytimes.com/games/connections*`.
- Network requests, all to NYT, all from that page:
  - `/svc/connections/v2/<date>.json` (published answers): category names
    and colors for puzzles the user has finished.
  - `https://static01.nyt.com/newsgraphics/2024/connections-bot/game/<date>-summary.json`
    (public Connections Bot stats, CORS `*`) for past puzzles.
  - `/svc/games/state/connections/latests?puzzle_ids=…` only when the user
    clicks "import from NYT"; it reads their own saved games with their NYT
    session and changes nothing on the account.
- Storage: `browser.storage.local` (`unlimitedStorage`) for the history.
- History files the user imports are untrusted: tile markup is rebuilt
  through an element/attribute allow-list (`safeTileNodes`), never
  `innerHTML`.
