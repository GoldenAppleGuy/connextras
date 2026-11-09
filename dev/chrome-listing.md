# Chrome Web Store / Edge Add-ons listing

Upload `connextras-<version>-chrome.zip` (made by `python build.py`). The
same zip works for the Chrome Web Store (developer.chrome.com/docs/webstore,
one-time $5 registration) and Microsoft Edge Add-ons
(partner.microsoft.com, free). Name, summary, description and screenshots:
reuse `dev/amo-listing.md` and `dev/listing/`. Chrome wants a 128×128 store
icon: `extension/icon-128.png`. Screenshots must be 1280×800 or 640×400:
the ones in `dev/listing/` are 1280×800.

## Category

Entertainment (Chrome) / Entertainment (Edge)

## Privacy practices tab (Chrome Web Store)

**Single purpose**

Adds solving tools and a personal solve history to the New York Times
Connections puzzle page: rearranging and color-tagging tiles, undo, a
puzzle clock, and a history of the user's own puzzles with stats.

**Permission justifications**

- `storage`: saves the user's puzzle history (guesses, times, tile order,
  color tags) in the browser, so it persists across visits.
- `unlimitedStorage`: the history keeps every puzzle the user has played
  (one record per puzzle, with the tiles of each guess), which can grow
  past the default quota over time.
- Host permission `https://www.nytimes.com/games/connections*`: the only
  page the content script runs on; it adds the tools to the puzzle board.

**Remote code**

No, I am not using remote code. (All JavaScript is in the package; the
extension only fetches JSON data from NYT.)

**Data usage**

Check none of the data types: nothing is collected or transmitted to the
developer. History stays in the browser's extension storage. Certify the
three disclosures (not sold, not used for unrelated purposes, not used for
creditworthiness).

**Privacy policy URL**

Not required when no user data is collected. If asked, link the README's
Privacy section:
https://github.com/GoldenAppleGuy/connextras#privacy

## Support / homepage

https://github.com/GoldenAppleGuy/connextras/issues
