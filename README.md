# Connextras

A browser add-on (Firefox, Chrome, Edge) that adds the tools NYT Connections leaves out: rearrange
and color-tag tiles while you think, undo, a puzzle clock, and a history of
every puzzle you've played with your guesses, results and stats.

Unofficial: not made by or affiliated with The New York Times.

Found a bug or have an idea? [Open an issue](https://github.com/GoldenAppleGuy/connextras/issues).

## Features

- **Rearrange tiles**: drag a tile onto another to swap them, or use the
  arrow keys. Ctrl+Z undoes. NYT's Shuffle still works.
- **Color tags**: hold right-click on a tile and flick toward a corner, or
  hover and press 1-4 (0 clears), to mark your own guesses at groups.
- **Puzzle clock**: starts with the puzzle, pauses while the tab is hidden,
  and stops at the Submit that finishes it. Click it to hide it.
- **History**: every puzzle you play, with each guess drawn like NYT's
  tiles, the category names, one-away guesses, your result and time, and
  the day you played it. Search by word, category or date.
- **Stats**: played, win %, perfect games, average and best time, streak,
  purple first, reverse rainbow (purple → blue → green → yellow), and
  "rarest first" (your first group was the one fewest players started with).
- **How others played** (from NYT's Connections Bot, for past puzzles): the
  share of winners who solved each group first, and how many players made
  each of your wrong guesses.
- **Import from NYT**: rebuild finished puzzles saved to your NYT account
  (guesses and results; NYT keeps no solve time), for any date range.
- **Export and import** your history as a file.
- **Dark mode** toggle.

Everything is kept in your browser only. Removing the add-on deletes its
history, so export it first if you want to keep it.

## Privacy

The add-on collects no data and has no server of its own. It only talks to
NYT, from the Connections page:

- `www.nytimes.com/svc/connections/v2/<date>.json`: NYT's published
  answers, for category names and colors of puzzles you've finished.
- `static01.nyt.com/.../connections-bot/game/<date>-summary.json`:
  Connections Bot's public player stats for past puzzles.
- `www.nytimes.com/svc/games/state/connections/latests`: your saved games,
  only when you click "import from NYT" while signed in to NYT.
- Tile pictures of picture puzzles in your history load from the image
  server NYT's game uses (`games-phoenix-assets-prd.s3.amazonaws.com`).

## Install

Firefox: from [addons.mozilla.org](https://addons.mozilla.org/) (search
for "Connextras"). Chrome and Edge: from the Chrome Web Store or Edge
Add-ons once published, or load it yourself (below).

To build it yourself:

```
python build.py
```

That writes `connextras-<version>.xpi` (Firefox) and
`connextras-<version>-chrome.zip` (Chrome/Edge). For development, load the
`extension/` folder directly: Firefox `about:debugging` → This Firefox →
Load Temporary Add-on → `extension/manifest.json`; Chrome/Edge
`chrome://extensions` → Developer mode → Load unpacked → `extension/`.

## Development

See [AGENTS.md](AGENTS.md) for how it works, the offline test page
(`dev/harness.html?selftest`) and the live smoke test (`node dev/smoke.mjs`).

## License

[MIT](LICENSE)
