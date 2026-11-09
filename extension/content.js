(() => {
  // NYT uses hashed CSS-module class names, so try stable attributes first
  // and fall back to partial class matches.
  const CARD_SELECTORS = [
    'label[data-testid="card-label"]',
    '[data-testid="card-label"]',
    'label[for^="inner-card"]',
    '[class*="Card-module_cardLabel"]',
    '[class*="Card-module_card"]',
  ];
  const DRAG_THRESHOLD = 6; // px of movement before a press becomes a drag
  const CLICK_GRACE_MS = 300; // window in which trailing native events are dropped

  // Tag colors in quadrant order: top-left, top-right, bottom-left, bottom-right.
  const TAG_COLORS = ['yellow', 'green', 'blue', 'purple'];
  // Tile tags: key -> color name. Purely visual; the game never sees them.
  const tags = new Map();

  // Visual order of tile keys (top-left to bottom-right), or null if untouched.
  let order = null;
  // Undo stack of {order, tags} snapshots, capped at HISTORY_MAX.
  let history = [];
  const HISTORY_MAX = 50;
  // Current press: { card, x, y, id, dragging, over, saved }
  let gesture = null;
  let replaying = false; // true while we re-dispatch a genuine click
  // The native mouseup/click still owed for the last tile press we handled
  // ourselves: { mouseup, click, at }. Only those are dropped — never a
  // click that belongs to a new press (e.g. a quick Submit right after).
  let trailing = null;
  // Right-button "hold, flick, release" tagging gesture (see Color tags).
  let tagGesture = null; // { id } while the right button is held on a tile
  let tagEndedAt = 0; // when the last one ended (to swallow trailing events)

  let lastSelector = null; // which CARD_SELECTORS entry matched (debug)

  const getCards = () => {
    for (const sel of CARD_SELECTORS) {
      const found = [...document.querySelectorAll(sel)];
      if (found.length) {
        lastSelector = sel;
        return found;
      }
    }
    return [];
  };

  // --- Tile identity ---
  // Words are not reliable keys: picture and emoji puzzles have tiles with no
  // text (or text that isn't unique), which collapses every tile to the same
  // key. Prefer DOM identity (label -> input id), then accessible names,
  // then text. `keyOf` is for bookkeeping; `textOf` is for display/logging.
  const keyOf = (card) => {
    const f = card.getAttribute('for');
    if (f) return f;
    const input = card.querySelector('input[id]');
    if (input) return input.id;
    if (card.id) return card.id;
    const al = card.getAttribute('aria-label');
    if (al) return `aria:${al}`;
    const img = card.querySelector('img[alt]');
    if (img) return `img:${img.alt}`;
    const t = card.textContent.trim();
    if (t) return `text:${t.toUpperCase()}`;
    return `idx:${getCards().indexOf(card)}`; // last resort, unstable
  };
  const textOf = (card) => {
    // NYT's card label carries the word twice (visual + screen-reader
    // copy). If every text-bearing child is identical, take one.
    const kids = [...card.children]
      .map((k) => k.textContent.trim())
      .filter(Boolean);
    if (kids.length && kids.every((t) => t === kids[0])) {
      return kids[0].toUpperCase();
    }
    return (
      card.textContent.trim().toUpperCase() ||
      card.getAttribute('aria-label') ||
      (card.querySelector('img[alt]') || {}).alt ||
      keyOf(card)
    );
  };

  // Lowest common ancestor of all cards = the grid container.
  const commonParent = (cards) => {
    let p = cards[0].parentElement;
    while (p && !cards.every((c) => p.contains(c))) p = p.parentElement;
    return p;
  };

  // The direct child of the container that holds this card. We set CSS
  // `order` on this rather than moving DOM nodes, so React never notices.
  const itemFor = (card, container) => {
    let el = card;
    while (el.parentElement && el.parentElement !== container) el = el.parentElement;
    return el;
  };

  const cardFrom = (el) =>
    el && el.nodeType ? getCards().find((c) => c.contains(el)) || null : null;

  // --- Debug ---
  // On when the URL has ?cwdebug or localStorage['cw-debug'] === '1'. Logs to
  // the console and to an on-page HUD; window.__cw is always exposed so a
  // test harness (or the console) can inspect state without the HUD.
  const DEBUG = { on: false, events: [] };
  try {
    DEBUG.on =
      /[?&]cwdebug\b/.test(location.search) || localStorage.getItem('cw-debug') === '1';
  } catch (_) {}

  function dlog(...args) {
    if (!DEBUG.on) return;
    DEBUG.events.push(
      `${new Date().toLocaleTimeString('en-GB', { hour12: false })} ${args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ')}`
    );
    if (DEBUG.events.length > 60) DEBUG.events.shift();
    console.debug('[CW]', ...args);
    updateHud();
  }

  let hud = null;
  function showHud() {
    if (hud) return;
    hud = document.createElement('div');
    hud.setAttribute('data-cw-hud', '');
    document.body.appendChild(hud);
    updateHud();
  }
  function hideHud() {
    if (hud) hud.remove();
    hud = null;
  }
  function updateHud() {
    if (!hud) return;
    const cards = getCards();
    const rows = [
      `selector: ${lastSelector || '(none)'}  cards: ${cards.length}`,
      `keys: ${cards.map((c) => keyOf(c).replace(/^text:/, '')).join(', ')}`,
      `order: ${order ? order.map((k) => k.replace(/^text:/, '')).join(', ') : '(untouched)'}`,
      `tags: ${[...tags].map(([k, v]) => `${k.replace(/^text:/, '')}:${v}`).join(' ') || '(none)'}`,
      `clock: ${clockStart ? fmtClock(baseMs + (clockFrozen || Date.now()) - clockStart) : 'not started'}`,
      '--- events ---',
      ...DEBUG.events.slice(-12),
    ];
    hud.textContent = rows.join('\n');
  }

  window.__cw = {
    version: '',
    cards: getCards,
    keys: () => getCards().map(keyOf),
    texts: () => getCards().map(textOf),
    order: () => (order ? [...order] : null),
    tags: () => new Map(tags),
    events: () => [...DEBUG.events],
    times: () => readTimes(),
    ready: () => storeReadyP,
    putRecords(list) {
      for (const r of list) {
        const c = cleanRecord(r);
        if (!c) continue;
        c.id = c.id || newId(c.d || '');
        compactRecord(c);
        writeTimes(c);
      }
    },
    deleteRecord: (id) => deleteRecord(id),
    clearRecords: () => clearRecords(),
    migrate: () => migrateLegacy(),
    importFromNyt: (fetchImpl, since, until) => importFromNyt(fetchImpl, since, until),
    nytSince: () => nytSinceDate(),
    resetClock: () => resetClock(),
    fillRare: (fetchImpl) => fillRare(fetchImpl),
    clock: () => ({ start: clockStart, frozen: clockFrozen, base: baseMs, now: Date.now() }),
    removeNytImports: () => removeNytImports(),
    tileColors: (texts) => tileColors(new Set(texts.map((x) => x.toUpperCase()))),
    stats: () => historyStats(),
    importRecords: (data) => importRecords(data),
    keyOf,
    tag: setTag,
    move: moveCard,
    undo,
    setHidden,
    history: toggleHistory,
    debug(on = true) {
      DEBUG.on = on;
      if (on) showHud();
      else hideHud();
    },
  };

  // --- Order ---

  function clearOrderStyles() {
    const cards = getCards();
    if (!cards.length) return;
    const container = commonParent(cards);
    cards.forEach((c) => (itemFor(c, container).style.order = ''));
  }

  // Auto-advance intro/interstitial screens (e.g. the archive's "Admire
  // Puzzle" splash): click the play/continue button once per page load.
  let autoPlayed = false;
  function tryAutoAdvance() {
    if (autoPlayed) return;
    // Only click inside NYT "moment" intro screens (welcome/Admire). Never
    // touch stats/congrats/subscription modals — clicking a matching button
    // in one of those can navigate away (e.g. the bonus-hub CTA).
    const scope =
      document.querySelector('[data-testid="moment-wrapper"]') ||
      document.querySelector('.pz-moment');
    if (!scope) return;
    const btn =
      scope.querySelector('[data-testid="moment-btn-play"]') ||
      [...scope.querySelectorAll('button')].find(
        (b) =>
          /admire|play|start|continue|begin|resume|keep|got it/i.test(
            b.textContent.trim()
          ) && b.offsetParent
      );
    if (!btn || !btn.offsetParent) return;
    autoPlayed = true;
    dlog('auto-advance:', btn.textContent.trim());
    btn.click();
  }

  // Re-check unmarked guesses a beat after each board mutation (the reveal
  // animation inserts the solved row asynchronously).
  let markScheduled = false;
  const scheduleMark = () => {
    if (markScheduled) return;
    markScheduled = true;
    setTimeout(() => {
      markScheduled = false;
      markGuesses();
    }, 400);
  };

  function apply() {
    const cards = getCards();
    tryAutoAdvance();
    scheduleMark();
    // Hide/show the toolbar even when the board is empty (end screens), so
    // it can't float over the results UI at its last position.
    ensureUi();
    if (!cards.length) return;

    cards.forEach((c) => {
      c.setAttribute('data-cw-card', '');
      const tag = tags.get(keyOf(c));
      if (tag) c.setAttribute('data-cw-tag', tag);
      else c.removeAttribute('data-cw-tag');
    });
    if (!order) {
      ensureUi();
      updateHud();
      return;
    }

    const container = commonParent(cards);
    const keys = cards.map(keyOf);

    // Drop solved tiles, append any new ones.
    order = order.filter((k) => keys.includes(k));
    keys.forEach((k) => {
      if (!order.includes(k)) order.push(k);
    });

    // +1 so solved-group rows (default order 0) stay above the cards.
    cards.forEach((c) => {
      itemFor(c, container).style.order = String(order.indexOf(keyOf(c)) + 1);
    });
    ensureUi();
    updateHud();
  }

  function pushHistory() {
    history.push({ order: order ? [...order] : null, tags: new Map(tags) });
    if (history.length > HISTORY_MAX) history.shift();
  }

  function undo() {
    const h = history.pop();
    if (!h) return false;
    order = h.order;
    tags.clear();
    h.tags.forEach((v, k) => tags.set(k, v));
    if (!order) clearOrderStyles();
    apply();
    persistBoard();
    dlog('undo');
    return true;
  }

  function swap(a, b) {
    if (!puzzleEntry) resolvePuzzle(getCards());
    if (!order) order = getCards().map(keyOf);
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    if (i < 0 || j < 0) return;
    pushHistory();
    [order[i], order[j]] = [order[j], order[i]];
    dlog('swap', a, '<->', b);
    apply();
    persistBoard();
  }

  const ARROW_DIRS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };

  // Swap a card with its visual neighbor (the grid is always 4 wide), like a
  // drag into that slot. dir: ±1 for left/right, ±4 for up/down.
  function moveCard(card, dir) {
    const base = order || getCards().map(keyOf);
    const pos = base.indexOf(keyOf(card));
    const target = pos + dir;
    const rowEdge =
      (dir === -1 && pos % 4 === 0) || (dir === 1 && pos % 4 === 3);
    if (pos < 0 || rowEdge || target < 0 || target >= base.length) return false;
    swap(base[pos], base[target]);
    return true;
  }

  // --- Drag visuals ---

  // True if the card's own background is dark (e.g. a selected tile, or any
  // tile in dark mode), so a dark outline would disappear against it.
  function luminanceOf(color) {
    const m = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.1) return null; // transparent: nothing to clash with
    return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
  }
  function hasDarkBackground(card) {
    const l = luminanceOf(getComputedStyle(card).backgroundColor);
    return l !== null && l < 0.5;
  }

  // NYT marks a selected tile with a "Card-module_selected" class and a
  // checked hidden checkbox inside the label.
  function isSelected(card) {
    if (/selected/i.test(card.getAttribute('class') || '')) return true;
    const input = card.querySelector('input[type="checkbox"]');
    return !!(input && input.checked);
  }

  const OUTLINE_ON_LIGHT = '#5a594e'; // dark grey, for unselected tiles
  const OUTLINE_ON_DARK = '#efefe6'; // light grey, for selected tiles

  // The outline is applied inline with !important so it doesn't depend on
  // the stylesheet or on anything in the game's own CSS.
  function setOver(g, card) {
    if (g.over === card) return;
    if (g.over) {
      g.over.removeAttribute('data-cw-over');
      g.over.style.removeProperty('outline');
      g.over.style.removeProperty('outline-offset');
    }
    g.over = card;
    if (card) {
      card.setAttribute('data-cw-over', '');
      const dark = isSelected(card) || hasDarkBackground(card);
      const color = dark ? OUTLINE_ON_DARK : OUTLINE_ON_LIGHT;
      card.style.setProperty('outline', `3px dashed ${color}`, 'important');
      card.style.setProperty('outline-offset', '-3px', 'important');
    }
  }

  function beginDrag(g) {
    g.dragging = true;
    const s = g.card.style;
    g.saved = {
      pointerEvents: s.pointerEvents,
      zIndex: s.zIndex,
      position: s.position,
      transition: s.transition,
    };
    s.pointerEvents = 'none'; // so elementFromPoint sees what's underneath
    s.zIndex = '1000';
    s.transition = 'none';
    if (getComputedStyle(g.card).position === 'static') s.position = 'relative';
    g.card.setAttribute('data-cw-dragging', '');
    dlog('drag start', keyOf(g.card));
  }

  function endDrag(g) {
    const s = g.card.style;
    s.transform = '';
    s.pointerEvents = g.saved.pointerEvents;
    s.zIndex = g.saved.zIndex;
    s.position = g.saved.position;
    s.transition = g.saved.transition;
    g.card.removeAttribute('data-cw-dragging');
    setOver(g, null);
  }

  // --- Replay a genuine click so the game sees exactly one normal click ---

  function replayClick(card, e) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    };
    const ptr = {
      pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      isPrimary: true,
    };
    replaying = true;
    try {
      card.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...ptr, buttons: 1 }));
      card.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
      card.dispatchEvent(new PointerEvent('pointerup', { ...base, ...ptr, buttons: 0 }));
      card.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, detail: 1 }));
      card.click();
    } finally {
      replaying = false;
    }
  }

  // --- Input handling ---
  // Everything below runs in the capture phase on window, ahead of the game.
  // The game never sees the press/move/release of a drag. For a plain click
  // (no movement) we swallow the real events and replay them once.

  const swallow = (e) => e.stopImmediatePropagation();

  // Right/middle button presses on a tile never reach the game either: it
  // toggles selection on press/release without checking which button it was.
  // The right button is ours, for color tags: pressing it on a tile starts the
  // tagging gesture, and releasing it finishes it (see Color tags below).
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'].forEach((type) =>
    window.addEventListener(
      type,
      (e) => {
        if (replaying || e.button === 0) return;
        const card = cardFrom(e.target);
        const tagging = tagGesture || Date.now() - tagEndedAt < 300;
        if (!card && !tagging) return;
        swallow(e);
        if (e.button !== 2) return;
        if (type === 'pointerdown' && card) startTagGesture(card, e);
        else if (type === 'pointerup' && tagGesture) endTagGesture(e);
      },
      true
    )
  );

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (replaying) return;
      // A new press starts: whatever trailed the previous one is done.
      trailing = null;
      if (e.button !== 0) return;
      const card = cardFrom(e.target);
      if (!card) return;
      swallow(e);
      gesture = {
        card,
        x: e.clientX,
        y: e.clientY,
        id: e.pointerId,
        dragging: false,
        over: null,
        saved: null,
      };
    },
    true
  );

  window.addEventListener(
    'mousedown',
    (e) => {
      if (replaying || e.button !== 0 || !cardFrom(e.target)) return;
      swallow(e);
      e.preventDefault(); // no focus change, text selection, or native drag
    },
    true
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      const g = gesture;
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        beginDrag(g);
      }
      g.card.style.transform = `translate(${dx}px, ${dy}px)`;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = cardFrom(under);
      setOver(g, target && target !== g.card ? target : null);
    },
    true
  );

  window.addEventListener(
    'pointerup',
    (e) => {
      const g = gesture;
      if (replaying || !g || e.pointerId !== g.id) return;
      gesture = null;
      trailing = { mouseup: true, click: true, at: Date.now() };
      swallow(e);
      if (g.dragging) {
        const target = g.over;
        endDrag(g);
        if (target) swap(keyOf(g.card), keyOf(target));
      } else {
        replayClick(g.card, e);
      }
    },
    true
  );

  window.addEventListener(
    'pointercancel',
    (e) => {
      const g = gesture;
      if (!g || e.pointerId !== g.id) return;
      gesture = null;
      if (g.dragging) endDrag(g);
    },
    true
  );

  // The real mouseup/click that trails our pointerup is dropped (whatever its
  // target: after a drag, the click can land on the container, not a card).
  // Each is dropped once, and only until the next press begins.
  ['mouseup', 'click'].forEach((type) =>
    window.addEventListener(
      type,
      (e) => {
        if (replaying || !trailing || !trailing[type]) return;
        if (Date.now() - trailing.at > CLICK_GRACE_MS) {
          trailing = null;
          return;
        }
        trailing[type] = false;
        swallow(e);
        e.preventDefault(); // also cancels the label -> checkbox activation
      },
      true
    )
  );

  // --- Color tags ---
  // Hold the right button on a tile: its four quadrants light up in the tag
  // colors (yellow top-left, green top-right, blue bottom-left, purple
  // bottom-right). Drag into a quadrant and release to tag the tile. A plain
  // right-click (no drag) clears its tag. Escape cancels.
  // Or hover a tile and press 1-4 to set a color (pressing the same key again
  // removes it) and 0 to clear.

  const MOVE_THRESHOLD = 8; // px of drag before a press counts as a choice

  function setTag(card, color) {
    if (!puzzleEntry) resolvePuzzle(getCards());
    pushHistory();
    const key = keyOf(card);
    if (color) tags.set(key, color);
    else tags.delete(key);
    dlog('tag', key, '->', color || '(cleared)');
    apply();
    persistBoard();
  }

  let tagOverlay = null; // the quadrant overlay while a gesture is active

  function hideTagOverlay() {
    if (tagOverlay) tagOverlay.remove();
    tagOverlay = null;
  }

  // Four colored quadrants drawn over the tile.
  // It ignores the pointer (pointer-events:none) and is built from our own
  // attributes only, so it can never be mistaken for a card.
  function showTagOverlay(card, g) {
    hideTagOverlay();
    const r = g.rect;
    const el = document.createElement('div');
    el.setAttribute('data-cw-quad', '');
    Object.assign(el.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      borderRadius: getComputedStyle(card).borderRadius,
    });
    TAG_COLORS.forEach((color) => {
      const q = document.createElement('div');
      q.setAttribute('data-cw-quadrant', color);
      el.appendChild(q);
    });
    document.body.appendChild(el);
    tagOverlay = el;
  }

  function showHot(color) {
    if (!tagOverlay) return;
    if (color) tagOverlay.setAttribute('data-cw-hot', color);
    else tagOverlay.removeAttribute('data-cw-hot');
  }

  // The color a pointer position selects, or null for "none" (which clears).
  // Nothing is selected until the pointer has actually been dragged, so a
  // plain right-click always clears, wherever on the tile it lands.
  // After that, the quadrant the pointer is in decides.
  function pickAt(g, x, y) {
    if (!g.moved) {
      if (Math.hypot(x - g.x, y - g.y) < MOVE_THRESHOLD) return null;
      g.moved = true;
    }
    const dx = x - (g.rect.left + g.rect.width / 2);
    const dy = y - (g.rect.top + g.rect.height / 2);
    return TAG_COLORS[(dy < 0 ? 0 : 2) + (dx < 0 ? 0 : 1)];
  }

  // Press the right button on a tile: the quadrants appear right away.
  function startTagGesture(card, e) {
    const rect = card.getBoundingClientRect();
    const g = {
      id: e.pointerId,
      key: keyOf(card),
      rect,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      cancelled: false,
    };
    tagGesture = g;
    showTagOverlay(card, g);
  }

  // Release: apply whatever the pointer is over (nothing = clear the tag).
  function endTagGesture(e) {
    const g = tagGesture;
    tagGesture = null;
    tagEndedAt = Date.now();
    hideTagOverlay();
    if (g.cancelled) return;
    const color = pickAt(g, e.clientX, e.clientY);
    const card = getCards().find((c) => keyOf(c) === g.key);
    if (card) setTag(card, color);
  }

  function abortTagGesture() {
    tagGesture = null;
    hideTagOverlay();
  }

  window.addEventListener(
    'pointermove',
    (e) => {
      if (tagGesture && !tagGesture.cancelled) {
        showHot(pickAt(tagGesture, e.clientX, e.clientY));
      }
    },
    true
  );
  window.addEventListener('pointercancel', abortTagGesture, true);
  window.addEventListener('blur', abortTagGesture);

  // The native context menu never shows on a tile or while tagging. (On Windows
  // the event fires on release, so it needs a short grace period.) Nothing
  // else happens here: tagging is driven entirely by press/move/release.
  window.addEventListener(
    'contextmenu',
    (e) => {
      const tagging = tagGesture || Date.now() - tagEndedAt < 500;
      if (!cardFrom(e.target) && !tagging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (tagGesture) {
        tagGesture.cancelled = true;
        hideTagOverlay();
        return;
      }
      if (confirmPop) {
        closeConfirm();
        return;
      }
      if (histPanel) {
        toggleHistory();
        return;
      }
    }
    // Ignore typing in text fields. (The game's hidden checkboxes can hold
    // focus after a click, so those don't count.)
    const t = e.target;
    const typing =
      t &&
      (t.isContentEditable ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        (t.tagName === 'INPUT' &&
          !['checkbox', 'radio', 'button', 'submit'].includes(t.type)));

    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === 'z' &&
      !typing
    ) {
      if (undo()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (typing) return;

    // Arrow keys move the selected card (or the hovered one if none is
    // singly selected), like a drag into that neighbor.
    const dir = ARROW_DIRS[e.key];
    if (dir) {
      const sel = getCards().filter(isSelected);
      const card =
        sel.length === 1
          ? sel[0]
          : getCards().find((c) => c.matches(':hover'));
      if (!card || !moveCard(card, dir)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    const idx = e.key.length === 1 ? '1234'.indexOf(e.key) : -1;
    if (idx < 0 && e.key !== '0') return;

    const card = getCards().find((c) => c.matches(':hover'));
    if (!card) return;

    if (e.key === '0') {
      setTag(card, null);
    } else {
      const color = TAG_COLORS[idx];
      setTag(card, tags.get(keyOf(card)) === color ? null : color);
    }
  });

  // --- Toolbar: clock + dark toggle ---
  // A fixed-position bar anchored just above the grid's top-right corner.
  // Fixed (not inside the React tree) so the game can't re-render it away.

  let ui = null; // { bar, clock, clockShow, toggle, anchor }
  let clockStart = 0; // when the current visit's timing started
  let clockFrozen = 0; // set when the board empties (solved / navigated away)
  let baseMs = 0; // time accumulated on this puzzle during previous visits
  let puzzleEntry = null; // the cw-times record for this puzzle
  let times = null; // last-read list of records (for debugging/__cw)

  // --- History store ---
  // One record per puzzle (time, board, guesses), each under its own key
  // ("rec:<id>") in the extension's own storage: no size cap (the manifest
  // asks for unlimitedStorage), not readable by the site, and since a save
  // only ever writes its own puzzle's key, open tabs can't overwrite each
  // other. Reads come from an in-memory mirror (id -> record) loaded once
  // at startup and kept current across tabs by change events, so the rest
  // of the code stays synchronous. Nothing that needs records runs until
  // the store is ready (see storeReady).
  // Without extension storage (dev/harness.html loads this file as a plain
  // page script) the same keys live in localStorage, prefixed "cw-".
  // History from before 1.9 lived in localStorage['cw-times'] (an array,
  // capped at 60). It is left untouched; each of its records is copied in
  // once, remembered by id in META_MIGRATED_IDS so a record deleted later
  // never comes back. This is checked on every load rather than once: a
  // private window (or any page whose storage is empty) sees no legacy
  // records, and must not end the migration for the normal windows.
  const REC = 'rec:';
  const META_MIGRATED_IDS = 'meta:migratedIds';
  const LEGACY_KEY = 'cw-times';

  // Firefox: browser.storage; Chrome/Edge: chrome.storage (promise-based in
  // MV3, same get/set/remove/onChanged). Without either (dev harness page),
  // the localStorage fallback below.
  const extStorage = (() => {
    try {
      for (const api of [globalThis.browser, globalThis.chrome]) {
        if (api && api.storage && api.storage.local && api.storage.onChanged) return api.storage;
      }
    } catch (_) {}
    return null;
  })();

  const backend = extStorage
    ? {
        all: () => extStorage.local.get(null),
        set: (obj) => extStorage.local.set(obj),
        remove: (keys) => extStorage.local.remove(keys),
        watch(cb) {
          extStorage.onChanged.addListener((ch, area) => {
            if (area !== 'local') return;
            const out = {};
            for (const [k, v] of Object.entries(ch)) out[k] = v.newValue;
            cb(out);
          });
        },
      }
    : {
        async all() {
          const o = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k.startsWith('cw-rec:') && !k.startsWith('cw-meta:')) continue;
            try {
              o[k.slice(3)] = JSON.parse(localStorage.getItem(k));
            } catch (_) {}
          }
          return o;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj))
            localStorage.setItem(`cw-${k}`, JSON.stringify(v));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) localStorage.removeItem(`cw-${k}`);
        },
        watch(cb) {
          window.addEventListener('storage', (e) => {
            if (!e.key || !e.key.startsWith('cw-rec:')) return;
            let v;
            try {
              v = e.newValue ? JSON.parse(e.newValue) : undefined;
            } catch (_) {}
            cb({ [e.key.slice(3)]: v });
          });
        },
      };

  const mirror = new Map(); // id -> record
  let storeReady = false;

  const newId = (date) =>
    `${date}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;

  // Pre-1.9 records from localStorage. Those stored no id: derive one from
  // stored fields, so every tab derives the same id for the same record.
  function legacyRecords() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return [];
      const v = JSON.parse(raw);
      return (Array.isArray(v) ? v : [])
        .filter((e) => e && Array.isArray(e.tiles) && typeof e.ms === 'number')
        .map((e) => {
          if (!e.id) e.id = `${e.d || ''}|${e.started || 0}|${e.u || 0}`;
          return e;
        });
    } catch (_) {
      return [];
    }
  }

  let migratedIds = new Set();
  async function migrateLegacy() {
    const legacy = legacyRecords().filter((e) => !migratedIds.has(e.id));
    if (!legacy.length) return 0;
    // A puzzle already in the store (played with 1.9+) keeps its record;
    // the older copy is only marked as handled.
    const dates = new Set([...mirror.values()].map((e) => e.d).filter(Boolean));
    const batch = {};
    let copied = 0;
    for (const e of legacy) {
      migratedIds.add(e.id);
      if (mirror.has(e.id) || (e.d && dates.has(e.d))) continue;
      compactRecord(e);
      mirror.set(e.id, e);
      if (e.d) dates.add(e.d);
      batch[REC + e.id] = e;
      copied++;
    }
    batch[META_MIGRATED_IDS] = [...migratedIds];
    await backend.set(batch);
    dlog('migrated', copied, 'of', legacy.length, 'records from localStorage');
    return copied;
  }

  // Changes from other tabs are watched from the start; ones that arrive
  // while the store is still loading are replayed afterwards, so none slip
  // between the initial read and the listener.
  let pendingChanges = [];
  backend.watch((ch) => (pendingChanges ? pendingChanges.push(ch) : onStoreChange(ch)));
  const storeReadyP = (async () => {
    try {
      const all = await backend.all();
      for (const [k, v] of Object.entries(all))
        if (k.startsWith(REC) && v && Array.isArray(v.tiles))
          mirror.set(k.slice(REC.length), v);
      if (Array.isArray(all[META_MIGRATED_IDS])) migratedIds = new Set(all[META_MIGRATED_IDS]);
      await migrateLegacy();
    } catch (err) {
      dlog('history store failed to load:', String(err));
    }
    storeReady = true;
    const queued = pendingChanges;
    pendingChanges = null;
    queued.forEach(onStoreChange);
  })();

  // Another tab saved or deleted a puzzle. For the puzzle being played
  // here, fold the other tab's changes into this tab's live record (if this
  // tab just kept saving its own copy, the two would erase each other's
  // guesses); for everything else, take the stored copy.
  let storeRenderQueued = false;
  function onStoreChange(changes) {
    let changed = false;
    for (const [k, v] of Object.entries(changes)) {
      if (!k.startsWith(REC)) continue;
      const id = k.slice(REC.length);
      if (puzzleEntry && id === puzzleEntry.id) {
        if (v && Array.isArray(v.tiles) && mergeIntoLive(v)) {
          writeTimes();
          changed = true;
        }
        continue;
      }
      if (v && Array.isArray(v.tiles)) mirror.set(id, v);
      else mirror.delete(id);
      changed = true;
    }
    if (changed && histPanel && !storeRenderQueued) {
      storeRenderQueued = true;
      setTimeout(() => {
        storeRenderQueued = false;
        renderHistory();
      }, 50);
    }
  }

  // Merge another tab's copy of the live puzzle into this tab's record:
  // union of guesses (by their words), colors/one-away either side learned,
  // union of tiles, and the larger time. Returns true if anything changed
  // (only then is it saved, so tabs can't echo saves back and forth).
  const guessKey = (g) => g.map((x) => (x && typeof x === 'object' ? x.t : x)).sort().join('|');
  function mergeIntoLive(inc) {
    const live = puzzleEntry;
    let changed = false;
    const mine = new Map((live.guesses || []).map((g) => [guessKey(g), g]));
    for (const g of inc.guesses || []) {
      const ours = mine.get(guessKey(g));
      if (!ours) {
        const copy = g.map((x) =>
          x && typeof x === 'object' && x.s
            ? { ...x, s: compactSnap(expandSnap(x.s, inc.css), live) }
            : x
        );
        (live.guesses = live.guesses || []).push(copy);
        mine.set(guessKey(g), copy);
        changed = true;
        continue;
      }
      g.forEach((x) => {
        if (!x || typeof x !== 'object') return;
        const o = ours.find((y) => y && typeof y === 'object' && y.t === x.t);
        if (!o) return;
        if (x.correct && !o.correct) {
          o.correct = x.correct;
          changed = true;
        }
        if (x.oneAway && !o.oneAway) {
          o.oneAway = true;
          changed = true;
        }
      });
    }
    const tiles = new Set([...live.tiles, ...(inc.tiles || [])]);
    if (tiles.size !== live.tiles.length) {
      live.tiles = [...tiles];
      changed = true;
    }
    if (inc.completed && !live.completed) {
      live.completed = inc.completed;
      changed = true;
    }
    // The other tab reset the clock (debug menu): follow it, and from then
    // on ignore its older, larger times. Otherwise both tabs time the same
    // wall clock: keep the larger total.
    if ((inc.clockReset || 0) > (live.clockReset || 0)) {
      live.clockReset = inc.clockReset;
      live.ms = inc.ms || 0;
      baseMs = live.ms;
      clockStart = clockFrozen || Date.now();
      changed = true;
    } else if (clockStart && (inc.clockReset || 0) === (live.clockReset || 0)) {
      const total = baseMs + (clockFrozen || Date.now()) - clockStart;
      if ((inc.ms || 0) > total + 1000) {
        baseMs += inc.ms - total;
        live.ms = inc.ms;
        changed = true;
      }
    }
    if (changed) live.u = Math.max(live.u || 0, inc.u || 0, Date.now());
    return changed;
  }

  const readTimes = () => (times = [...mirror.values()]);

  // Save one record (default: the current puzzle's).
  const writeTimes = (entry = puzzleEntry) => {
    if (!entry || !entry.id) return;
    mirror.set(entry.id, entry);
    backend.set({ [REC + entry.id]: entry }).catch((err) => dlog('save failed:', String(err)));
  };

  function deleteRecord(id) {
    mirror.delete(id);
    backend.remove(REC + id).catch(() => {});
  }

  function clearRecords() {
    const keys = [...mirror.keys()].map((id) => REC + id);
    mirror.clear();
    backend.remove(keys).catch(() => {});
  }

  // Tile snapshots repeat the same inline styles across a puzzle's tiles:
  // keep each distinct style once per record (rec.css) and point to it
  // from the snapshot (data-cs="<index>"). Cuts saved tiles ~8x.
  function compactSnap(html, rec) {
    if (!/\sstyle=/.test(html)) return html;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    rec.css = rec.css || [];
    doc.body.querySelectorAll('[style]').forEach((el) => {
      const st = el.getAttribute('style');
      let i = rec.css.indexOf(st);
      if (i < 0) i = rec.css.push(st) - 1;
      el.removeAttribute('style');
      el.setAttribute('data-cs', String(i));
    });
    return doc.body.innerHTML;
  }
  // Inverse of compactSnap: put a record's shared styles back inline.
  function expandSnap(html, css) {
    if (!/data-cs=/.test(html)) return html;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    doc.body.querySelectorAll('[data-cs]').forEach((el) => {
      const st = css && css[+el.getAttribute('data-cs')];
      el.removeAttribute('data-cs');
      if (typeof st === 'string') el.setAttribute('style', st);
    });
    return doc.body.innerHTML;
  }
  function compactRecord(rec) {
    for (const g of rec.guesses || [])
      for (const x of g) if (x && typeof x === 'object' && x.s) x.s = compactSnap(x.s, rec);
  }

  // --- History export / import ---
  // Export writes the stored records to a JSON file. Import merges a file
  // back in: one record per puzzle date (or id, for undated records); when
  // both sides have a puzzle, the more recently played copy wins. Imported
  // files may come from anywhere, so every field is validated and rebuilt
  // (cleanRecord), and stored tile snapshots are only ever rendered through
  // safeTileNodes, never as raw HTML.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CORRECT = [...TAG_COLORS, 'solved'];
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

  function cleanItem(x) {
    if (typeof x === 'string') return x.slice(0, 200);
    if (!x || typeof x !== 'object') return null;
    const o = { t: str(x.t) };
    if (typeof x.s === 'string' && x.s.length <= 20000) o.s = x.s;
    if (typeof x.h === 'string' && x.h.length <= 20000) o.h = x.h;
    if (num(x.w)) o.w = num(x.w);
    if (CORRECT.includes(x.correct)) o.correct = x.correct;
    if (x.oneAway === true) o.oneAway = true;
    if (num(x.tries)) o.tries = num(x.tries);
    return o;
  }

  function cleanRecord(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.tiles)) return null;
    const tiles = r.tiles.map((t) => str(t)).filter(Boolean);
    if (!tiles.length) return null;
    const out = { tiles, ms: num(r.ms), u: num(r.u) };
    if (typeof r.id === 'string' && r.id) out.id = r.id.slice(0, 100);
    if (DATE_RE.test(r.d)) out.d = r.d;
    if (num(r.started)) out.started = num(r.started);
    if (num(r.completed)) out.completed = num(r.completed);
    if (r.split === true) out.split = true;
    if (r.nyt === true) out.nyt = true;
    if (num(r.clockReset)) out.clockReset = num(r.clockReset);
    if (TAG_COLORS.includes(r.rare)) out.rare = r.rare;
    if (r.cats && typeof r.cats === 'object') {
      const c = {};
      for (const k of TAG_COLORS) if (typeof r.cats[k] === 'string' && r.cats[k]) c[k] = r.cats[k].slice(0, 200);
      if (Object.keys(c).length) out.cats = c;
    }
    if (r.wrong && typeof r.wrong === 'object' && !Array.isArray(r.wrong)) {
      const w = {};
      for (const [k, v] of Object.entries(r.wrong).slice(0, 50)) {
        const n = Number(v);
        if (k.length <= 600 && Number.isFinite(n) && n >= 0 && n <= 100) w[k] = n;
      }
      out.wrong = w;
    }
    if (r.first && typeof r.first === 'object') {
      const f = {};
      for (const c of TAG_COLORS) {
        const v = Number(r.first[c]);
        if (Number.isFinite(v) && v >= 0 && v <= 100) f[c] = v;
      }
      if (Object.keys(f).length === 4) out.first = f;
    }
    if (Array.isArray(r.words)) out.words = r.words.map((t) => str(t)).filter(Boolean);
    if (r.tags && typeof r.tags === 'object') {
      out.tags = {};
      for (const [k, v] of Object.entries(r.tags))
        if (TAG_COLORS.includes(v)) out.tags[String(k).slice(0, 200)] = v;
    }
    // Shared tile styles (see compactSnap); indexes must stay aligned.
    if (Array.isArray(r.css)) out.css = r.css.slice(0, 500).map((x) => str(x, 4000));
    if (Array.isArray(r.guesses))
      out.guesses = r.guesses
        .filter(Array.isArray)
        .slice(0, 20)
        .map((g) => g.slice(0, 8).map(cleanItem).filter((x) => x !== null))
        .filter((g) => g.length);
    return out;
  }

  // Merge imported records into the store. Returns counts for the panel.
  function importRecords(data) {
    const list = Array.isArray(data) ? data : data && data.records;
    if (!Array.isArray(list)) throw new Error('not a history file');
    const incoming = list.map(cleanRecord).filter(Boolean);
    if (!incoming.length && list.length) throw new Error('no usable records');
    const store = readTimes();
    const keyOfRec = (e) => e.d || e.id;
    const res = { added: 0, updated: 0, kept: 0 };
    for (const r of incoming) {
      compactRecord(r);
      const ex = store.find((e) => keyOfRec(e) && keyOfRec(e) === keyOfRec(r));
      if (!ex) {
        if (!r.id || mirror.has(r.id)) r.id = newId(r.d || '');
        store.push(r);
        res.added++;
      } else if (r.u > (ex.u || 0) && ex !== puzzleEntry) {
        // (The puzzle being played here keeps this tab's live copy.)
        r.id = ex.id;
        store[store.indexOf(ex)] = r;
        res.updated++;
      } else {
        res.kept++;
        continue;
      }
      writeTimes(r);
    }
    return res;
  }

  function exportHistory() {
    const data = {
      app: 'connextras',
      version: window.__cw.version || '',
      exported: new Date().toISOString(),
      records: readTimes().slice().sort((a, b) => b.u - a.u),
    };
    const blob = new Blob([JSON.stringify(data, null, 1)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `connextras-history-${puzzleDateToday()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return data.records.length;
  }

  // A hidden file input in the panel's tools row (the import button opens
  // it); being in the DOM also lets the test harness hand it a file.
  function importInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.hidden = true;
    input.setAttribute('data-cw-import', '');
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        const res = importRecords(JSON.parse(await f.text()));
        const parts = [`${res.added} added`, `${res.updated} updated`];
        if (res.kept) parts.push(`${res.kept} already up to date`);
        histStatus = `Imported: ${parts.join(', ')}`;
      } catch (err) {
        histStatus = `Import failed: ${(err && err.message) || 'unreadable file'}`;
      }
      renderHistory();
    });
    return input;
  }

  // Rebuild a stored tile snapshot from an allow-list of elements and
  // attributes (no scripts, handlers, links or remote resources), so even a
  // tampered or imported record can't inject anything into the page.
  const SAFE_HTML = new Set(['div', 'span', 'p', 'b', 'strong', 'i', 'em', 'br', 'img']);
  const SAFE_SVG = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line',
    'polyline', 'polygon', 'text', 'tspan', 'defs', 'use', 'lineargradient',
    'radialgradient', 'stop', 'clippath', 'mask', 'title']);
  const SVG_ATTR = /^(viewbox|fill|fill-rule|fill-opacity|clip-rule|clip-path|stroke|stroke-[a-z-]+|d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|dx|dy|width|height|points|transform|opacity|offset|stop-color|stop-opacity|gradientunits|gradienttransform|preserveaspectratio|font-size|font-family|font-weight|text-anchor|dominant-baseline|mask|aria-hidden|focusable|role)$/;
  // Styles may only reference inline images, never load anything: after
  // removing data:image URLs, any other url(), image-set(), src(),
  // element(), cross-fade(), paint() or @import rejects the whole style.
  const safeStyle = (v) =>
    /url\s*\(|image-set\s*\(|\bsrc\s*\(|element\s*\(|cross-fade\s*\(|paint\s*\(|@import/i.test(
      v.replace(/url\(\s*["']?data:image\/[^)]*\)/gi, '')
    )
      ? null
      : v;

  function safeTileNodes(html, css) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const copy = (n) => {
      if (n.nodeType === 3) return document.createTextNode(n.nodeValue);
      if (n.nodeType !== 1) return null;
      const name = n.localName.toLowerCase();
      const isSvg = n.namespaceURI === SVG_NS;
      if (isSvg ? !SAFE_SVG.has(name) : !SAFE_HTML.has(name)) return null;
      const out = isSvg
        ? document.createElementNS(SVG_NS, n.localName)
        : document.createElement(name);
      for (const a of n.attributes) {
        const an = a.name.toLowerCase();
        let ok = false;
        if (an === 'style' || an === 'data-cs') {
          // data-cs: index into the record's shared styles (compactSnap).
          const raw = an === 'style' ? a.value : css && css[+a.value];
          const v = typeof raw === 'string' ? safeStyle(raw) : null;
          if (v !== null) out.setAttribute('style', v);
          continue;
        }
        if (an === 'data-cw-tile') ok = true;
        else if (isSvg) {
          if (an === 'href' || an === 'xlink:href') ok = a.value.startsWith('#');
          else ok = SVG_ATTR.test(an);
        } else if (name === 'img') {
          if (an === 'src') ok = /^(https:|data:image\/)/i.test(a.value.trim());
          else ok = ['alt', 'width', 'height'].includes(an);
        }
        if (ok) out.setAttribute(a.name, a.value);
      }
      n.childNodes.forEach((k) => {
        const c = copy(k);
        if (c) out.appendChild(c);
      });
      return out;
    };
    const frag = document.createDocumentFragment();
    doc.body.childNodes.forEach((k) => {
      const c = copy(k);
      if (c) frag.appendChild(c);
    });
    return frag;
  }

  function puzzleSig(cards) {
    const texts = [...new Set(cards.map(textOf).filter(Boolean))].sort();
    return texts.length ? texts : null;
  }

  // The puzzle's own date, most reliable first: the URL (archive puzzles),
  // then the date NYT prints above the puzzle ("November 8, 2026" in
  // .pz-game-date — unlike the computer's clock it doesn't roll over at
  // midnight or with time zones), then today's date.
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
  const urlDate = () => {
    const m = location.pathname.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  };
  const pageDate = () => {
    const el = document.querySelector('.pz-game-date');
    const m = el && el.textContent.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    if (mi < 0) return null;
    return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  };
  const puzzleDate = () => urlDate() || pageDate() || puzzleDateToday();

  const puzzleDateToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
  };

  const overlapOf = (en, cur) =>
    (en.tiles || []).reduce((n, t) => n + (cur.has(t) ? 1 : 0), 0);

  function matchPuzzle(sig) {
    const cur = new Set(sig);
    const date = puzzleDate();
    const store = readTimes();
    // The puzzle date is the identity; shared tiles only confirm it.
    // Different puzzles can share words (e.g. VIDEO GAME on Mar 4 and Mar
    // 9), so overlap alone must never merge two dates. Within a date, a
    // subset covers mid-solve reloads, and merging covers a first save made
    // while partially solved.
    let best = null;
    let bestOverlap = 0;
    for (const en of store) {
      if (en.d && en.d !== date) continue;
      const overlap = overlapOf(en, cur);
      // An undated (legacy) record needs most of the board to match.
      const need = en.d ? 1 : Math.max(1, Math.min(cur.size, 8));
      if (overlap >= need && overlap > bestOverlap) {
        best = en;
        bestOverlap = overlap;
      }
    }
    if (!best) {
      best = { id: newId(date), tiles: [...cur], ms: 0, u: 0, d: date, started: 0 };
    } else {
      best.tiles = [...new Set([...best.tiles, ...cur])];
      best.d = best.d || date;
      // Cards present = puzzle isn't finished; clears a premature completion
      // stamp from an earlier navigate-away.
      delete best.completed;
    }
    best.started = best.started || Date.now();
    best.u = Date.now();
    writeTimes(best);
    return best;
  }

  // The board on screen belongs to a different puzzle than puzzleEntry.
  function puzzleChanged(cards) {
    if (!puzzleEntry) return false;
    // Only trust the puzzle's own date here (URL or page), not the clock:
    // "today" ticks over at midnight while the same puzzle is on screen.
    const own = urlDate() || pageDate();
    if (own && puzzleEntry.d && puzzleEntry.d !== own) return true;
    const sig = puzzleSig(cards);
    return !!sig && overlapOf(puzzleEntry, new Set(sig)) === 0;
  }

  function saveTime() {
    if (!puzzleEntry || !clockStart) return;
    puzzleEntry.ms = baseMs + (clockFrozen || Date.now()) - clockStart;
    puzzleEntry.u = Date.now();
    writeTimes();
  }

  // Debug menu: set the puzzle being played back to 0:00 (e.g. after
  // testing on it). Guesses, order and tags stay. clockReset tells other
  // tabs on this puzzle to follow instead of merging the old time back.
  function resetClock() {
    if (!puzzleEntry) return false;
    baseMs = 0;
    if (clockStart) clockStart = clockFrozen || Date.now();
    const now = Date.now();
    puzzleEntry.ms = 0;
    puzzleEntry.started = now;
    puzzleEntry.clockReset = now;
    puzzleEntry.u = now;
    writeTimes();
    histStatus = 'Clock reset to 0:00';
    renderHistory();
    tickClock();
    return true;
  }

  // Identify the current puzzle, restore any stored arrangement/tags, and
  // pick the clock up where it left off. Runs on board (re)appearance and
  // lazily before the first mutation.
  let lastEntry = null;
  function resolvePuzzle(cards) {
    if (!storeReady) return; // records not loaded yet: don't start a duplicate
    const sig = puzzleSig(cards);
    let e = null;
    try {
      e = sig ? matchPuzzle(sig) : null;
    } catch (_) {}
    puzzleEntry = e;
    baseMs = e ? e.ms : 0;
    clockStart = Date.now();
    clockFrozen = 0;
    if (e && e !== lastEntry) {
      restoreBoard(e, cards);
      history = [];
    }
    lastEntry = e;
    if (baseMs) dlog('clock resumed at', fmtClock(baseMs));
  }

  // Stored board state is keyed by tile *text* (stable across reloads and id
  // churn), mapped back onto the current tiles' keys here.
  function restoreBoard(e, cards) {
    const keyByText = new Map();
    cards.forEach((c) => {
      const t = textOf(c);
      if (t) keyByText.set(t, keyOf(c));
    });
    order = Array.isArray(e.words)
      ? e.words.map((t) => keyByText.get(t)).filter(Boolean)
      : null;
    if (order && !order.length) order = null;
    tags.clear();
    if (e.tags && typeof e.tags === 'object') {
      for (const [t, color] of Object.entries(e.tags)) {
        const k = keyByText.get(t);
        if (k && TAG_COLORS.includes(color)) tags.set(k, color);
      }
    }
    if (!order) clearOrderStyles();
    apply();
    dlog('restored board state', order ? `${order.length} tiles` : 'no order');
  }

  // Write the live arrangement + tags into the current puzzle's record.
  function persistBoard() {
    if (!puzzleEntry) resolvePuzzle(getCards());
    if (!puzzleEntry) return;
    const cards = getCards();
    const textByKey = new Map(cards.map((c) => [keyOf(c), textOf(c)]));
    puzzleEntry.words = (order || cards.map(keyOf))
      .map((k) => textByKey.get(k))
      .filter(Boolean);
    const t = {};
    for (const [k, color] of tags) {
      const w = textByKey.get(k);
      if (w) t[w] = color;
    }
    puzzleEntry.tags = t;
    puzzleEntry.u = Date.now();
    writeTimes();
  }

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
  };

  const nearRgb = (rgb, t) =>
    Math.abs(rgb[0] - t[0]) < 36 &&
    Math.abs(rgb[1] - t[1]) < 36 &&
    Math.abs(rgb[2] - t[2]) < 36;

  // --- Toolbar placement ---
  // The bar lives inside the board itself rather than floating over the
  // page, so it scrolls, appears, disappears and gets covered (modals,
  // results screens) together with the puzzle — no polling and no overlap
  // detection. On NYT it sits on the "Create four groups of four!" heading
  // row, right-aligned with the grid; that form exists while playing and on
  // the finished board. Elsewhere (the dev harness) it sits just above the
  // top-right corner of the wrapper around the grid and solved rows.
  let barHost = null; // { el, mode: 'heading' | 'above' }

  function findBarHost() {
    const board = document.querySelector('[data-testid="connections-board"]');
    const form = board && board.querySelector('form');
    if (form && form.querySelector('h2')) return { el: form, mode: 'heading' };
    // Generic: keep the wrapper once found, so the bar stays put after the
    // last tile is solved (the grid's own container may go away).
    if (barHost && barHost.mode === 'above' && barHost.el.isConnected) return barHost;
    const cards = getCards();
    const grid = cards.length ? commonParent(cards) : null;
    const wrap = grid && grid.parentElement;
    if (wrap && wrap !== document.body) return { el: wrap, mode: 'above' };
    return null;
  }

  function ensureUi() {
    const host = findBarHost();
    if (!host) {
      if (ui && ui.bar.isConnected) ui.bar.remove();
      barHost = null;
      return;
    }
    if (!ui) {
      const bar = document.createElement('div');
      bar.setAttribute('data-cw-bar', '');

      // The clock doubles as a button: click to hide it, click the small
      // restore icon to bring it back. Persisted in localStorage.
      const clock = document.createElement('button');
      clock.setAttribute('data-cw-clock', '');
      clock.type = 'button';
      clock.title = 'Hide timer';
      clock.textContent = '0:00';
      clock.addEventListener('click', () => setClockVisible(false));

      const clockShow = document.createElement('button');
      clockShow.setAttribute('data-cw-clock-show', '');
      clockShow.type = 'button';
      clockShow.title = 'Show timer';
      clockShow.textContent = '◷';
      clockShow.addEventListener('click', () => setClockVisible(true));

      const histBtn = document.createElement('button');
      histBtn.setAttribute('data-cw-history-btn', '');
      histBtn.type = 'button';
      histBtn.title = 'Puzzle time history';
      histBtn.textContent = 'History';
      histBtn.addEventListener('click', toggleHistory);

      const toggle = document.createElement('button');
      toggle.setAttribute('data-cw-dark-toggle', '');
      toggle.type = 'button';
      toggle.addEventListener('click', () => setDark(!darkOn()));

      bar.append(clock, clockShow, histBtn, toggle);
      ui = { bar, clock, clockShow, histBtn, toggle };
      applyDarkPref();
      setClockVisible(!clockHidden());
    }
    barHost = host;
    placeBar();
    syncToggle();
  }

  // Attach the bar to its host (React leaves an extra trailing child
  // alone; if the host is re-created, the next mutation re-attaches it) and
  // line it up with the heading.
  function placeBar() {
    if (!ui || !barHost) return;
    const { el, mode } = barHost;
    const bar = ui.bar;
    if (bar.parentElement !== el) {
      el.setAttribute('data-cw-bar-host', '');
      el.appendChild(bar);
    }
    if (bar.dataset.mode !== mode) bar.dataset.mode = mode;
    if (mode !== 'heading') return;
    const h2 = el.querySelector('h2');
    if (!h2) return;
    // Centered on the heading row; on narrow boards, where the bar would
    // run into the centered heading text, stack it just above instead.
    const range = document.createRange();
    range.selectNodeContents(h2);
    const text = range.getBoundingClientRect();
    const hostR = el.getBoundingClientRect();
    const clash = text.width > 0 && text.right + 8 > hostR.right - bar.offsetWidth;
    const top = clash ? h2.offsetTop - 6 : h2.offsetTop + h2.offsetHeight / 2;
    const topPx = `${Math.round(top)}px`;
    if (bar.style.top !== topPx) bar.style.top = topPx;
    if (clash !== bar.hasAttribute('data-stack')) bar.toggleAttribute('data-stack', clash);
    // Make room for the bar's own row above the heading. (Checked on the
    // host itself: NYT may re-create the form, which loses the attribute.)
    if (clash !== el.hasAttribute('data-cw-stacked')) el.toggleAttribute('data-cw-stacked', clash);
  }

  const CLOCK_KEY = 'cw-clock';
  const clockHidden = () => {
    try {
      return localStorage.getItem(CLOCK_KEY) === '0';
    } catch (_) {
      return false;
    }
  };

  function setClockVisible(visible) {
    try {
      localStorage.setItem(CLOCK_KEY, visible ? '1' : '0');
    } catch (_) {}
    if (!ui) return;
    ui.clock.style.display = visible ? '' : 'none';
    ui.clockShow.style.display = visible ? 'none' : '';
    dlog('clock', visible ? 'shown' : 'hidden');
  }

  // Only the clear-history popover still floats (it's anchored to a button
  // in the fixed sidebar), so scrolling/resizing just re-aims it.
  let posScheduled = false;
  const schedulePosition = () => {
    if (posScheduled) return;
    posScheduled = true;
    requestAnimationFrame(() => {
      posScheduled = false;
      placeBar();
      positionConfirm();
    });
  };

  // Pause the clock while the tab is hidden: freeze+save on hide, fold the
  // elapsed segment into baseMs and restart on return.
  function setHidden(hidden) {
    if (hidden) {
      if (clockStart && !clockFrozen) {
        clockFrozen = Date.now();
        saveTime();
      }
    } else if (clockFrozen && getCards().length) {
      baseMs += clockFrozen - clockStart;
      clockStart = Date.now();
      clockFrozen = 0;
    }
  }
  document.addEventListener('visibilitychange', () => setHidden(document.hidden));

  // --- History sidebar ---
  // Docked panel on the right edge listing recent puzzles: their puzzle
  // date (from the URL for archives), accumulated time, and guesses. The
  // current puzzle is included, marked "playing" with a live clock.

  let histPanel = null;

  // "Mar 4", plus the year when it isn't this year (archive puzzles).
  const fmtDate = (iso, u) => {
    const d = iso ? new Date(`${iso}T12:00:00`) : new Date(u);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  };
  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

  // Replica tiles use the board's own neutral tile colors when a plain
  // (unselected) tile is on screen; content.css has per-theme fallbacks.
  function syncTileColors() {
    if (!histPanel) return;
    histPanel.style.removeProperty('--cw-tile-bg');
    histPanel.style.removeProperty('--cw-tile-fg');
    const unsel = getCards().filter((c) => !isSelected(c));
    // Prefer a tile that isn't greyed out (4 selected disables the rest).
    const plain =
      unsel.find((c) => !/disabled/i.test(c.getAttribute('class') || '')) ||
      unsel[0];
    if (!plain) return;
    const cs = getComputedStyle(plain);
    histPanel.style.setProperty('--cw-tile-bg', cs.backgroundColor);
    histPanel.style.setProperty('--cw-tile-fg', cs.color);
  }

  // --- Check history against NYT's answers ---
  // For every dated puzzle, fetch the official answers (same endpoint the
  // game uses) and:
  //  - set each guessed tile's category color (fills gaps, fixes errors),
  //  - split off guesses that belong to a different puzzle (records merged
  //    by versions before 1.8) into an undated "Unknown date" record. Its
  //    date can't be known, and its time stays with the original record.
  // Records whose tiles mostly don't match the answers (picture puzzles
  // with differently named tiles) are left alone and counted as skipped.
  let checking = false;
  const answerCache = new Map();
  const pageFetch =
    typeof content !== 'undefined' && content && content.fetch
      ? (u) => content.fetch(u)
      : (u) => fetch(u);

  async function answersFor(d) {
    if (answerCache.has(d)) return answerCache.get(d);
    const res = await pageFetch(`/svc/connections/v2/${d}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const map = new Map();
    (j.categories || []).forEach((c, i) =>
      (c.cards || []).forEach((x) => {
        const w = String(x.content || x.image_alt_text || '').trim().toUpperCase();
        if (w) map.set(w, TAG_COLORS[i]);
      })
    );
    answerCache.set(d, map);
    return map;
  }

  // Update just the panel's status line (a full re-render per step would
  // redraw the whole history hundreds of times during a check).
  function setHistStatus(text) {
    histStatus = text;
    const st = histPanel && histPanel.querySelector('.status');
    if (st) st.textContent = text;
    else renderHistory();
  }

  // --- Import from NYT ---
  // NYT saves each signed-in player's progress per puzzle on its servers
  // (the game loads it from /svc/games/state/connections/latests). For every
  // finished puzzle that isn't in the history yet, rebuild a record: the
  // guesses (saved as tile positions, "3,7,9,14", into the published
  // answers), result and finish time. NYT keeps no solve time, so these
  // show "–" and stay out of the time stats. Unfinished puzzles are never
  // imported (their colors would spoil them). Records get nyt: true, so
  // "remove NYT imports" can take them all back out.
  let importingNyt = false;
  const NYT_BATCH = 50;

  async function nytJson(fetchImpl, url) {
    const res = await fetchImpl(url);
    if (res.status === 401 || res.status === 403) throw new Error('signed-out');
    if (!res.ok) {
      // Keep NYT's own reason ({"error": "..."} or text) for the status line.
      let why = '';
      try {
        const body = (await res.text()).trim();
        try {
          const j = JSON.parse(body);
          why = String((j && (j.error || j.message)) || body);
        } catch {
          why = body;
        }
      } catch {}
      why = why.replace(/\s+/g, ' ').slice(0, 120);
      const err = new Error(`HTTP ${res.status}${why ? ` (${why})` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Saved states for a list of puzzle ids. NYT answers 400 when it doesn't
  // like a request (too many ids, or an id it rejects): split the list and
  // retry, remember the smaller size for later batches (lim.size), and skip
  // single ids it still rejects. If nothing has worked after 10 rejected
  // single ids, the problem is the request itself: give up with NYT's reason.
  async function nytStates(fetchImpl, ids, lim) {
    try {
      const j = await nytJson(fetchImpl, `/svc/games/state/connections/latests?puzzle_ids=${ids.join(',')}`);
      lim.worked = true;
      return Array.isArray(j.states) ? j.states : [];
    } catch (err) {
      if (err.status !== 400) throw err;
      if (ids.length === 1) {
        lim.rejected++;
        if (!lim.worked && lim.rejected >= 10) throw err;
        return [];
      }
      const half = Math.ceil(ids.length / 2);
      lim.size = Math.min(lim.size, half);
      const a = await nytStates(fetchImpl, ids.slice(0, half), lim);
      return a.concat(await nytStates(fetchImpl, ids.slice(half), lim));
    }
  }

  // Positions in a saved guess: "3,7,9,14", or an array of numbers or cards.
  function guessPositions(cards) {
    const list = typeof cards === 'string' ? cards.split(',') : Array.isArray(cards) ? cards : [];
    return list
      .map((c) => (c && typeof c === 'object' ? (c.originalPosition ?? c.position) : c))
      .map(Number);
  }

  // One history record from NYT's saved state and the puzzle's answers, or
  // null when it can't be rebuilt faithfully.
  function nytRecord(d, data, ts, answers) {
    const byPos = new Map();
    (answers.categories || []).forEach((c, i) =>
      (c.cards || []).forEach((x) => {
        const w = String(x.content || x.image_alt_text || '').trim();
        if (!w || !Number.isInteger(x.position)) return;
        const item = { t: w, correct: TAG_COLORS[i] };
        // Picture puzzles (e.g. 2026-04-01): keep the image as the tile's
        // markup, drawn in a full tile like pre-1.8 picture tiles.
        const src = String(x.image_url || '').trim();
        if (!x.content && /^https:\/\//i.test(src)) {
          const im = document.createElement('img');
          im.setAttribute('src', src);
          im.setAttribute('alt', w);
          item.h = im.outerHTML;
        }
        byPos.set(x.position, item);
      })
    );
    if (byPos.size !== 16) return null;
    const guesses = [];
    for (const g of data.guesses || []) {
      const pos = guessPositions(g && g.cards);
      if (pos.length !== 4 || !pos.every((q) => byPos.has(q))) return null;
      guesses.push(pos.map((q) => ({ ...byPos.get(q) })));
    }
    if (!guesses.length) return null;
    const tiles = [...byPos.keys()].sort((a, b) => a - b).map((q) => byPos.get(q).t);
    // Category names come with the answers it already has.
    const cats = {};
    (answers.categories || []).forEach((c, i) => {
      if (c && c.title) cats[TAG_COLORS[i]] = String(c.title).slice(0, 200);
    });
    const rec = { id: newId(d), d, nyt: true, tiles, ms: 0, u: ts, completed: ts, guesses };
    if (Object.keys(cats).length === 4) rec.cats = cats;
    return rec;
  }

  // Import only puzzles from this date on (yyyy-mm-dd; '' = all of them).
  // Defaults to the first of the month of the oldest puzzle played here, so
  // the import doesn't walk back years the player never used the add-on in.
  const FIRST_PUZZLE = '2023-06-12';
  let nytSince = null; // the date field's value; null until it's changed
  function nytSinceDefault() {
    const ds = [...mirror.values()].filter((e) => !e.nyt && DATE_RE.test(e.d || '')).map((e) => e.d);
    return ds.length ? ds.sort()[0].slice(0, 8) + '01' : '';
  }
  function nytSinceDate() {
    return nytSince === null ? nytSinceDefault() : nytSince;
  }
  // ...and up to this date ('' = today).
  let nytUntil = '';

  async function importFromNyt(fetchImpl = pageFetch, since = nytSinceDate(), until = nytUntil) {
    if (importingNyt) return null;
    importingNyt = true;
    const sum = { added: 0, had: 0, unfinished: 0, skipped: 0, failed: 0 };
    const lim = { size: NYT_BATCH, worked: false, rejected: 0 };
    let error = '';
    try {
      setHistStatus('Importing from NYT…');
      renderHistory(); // show the disabled button
      // Puzzle ids aren't a count of days: ask NYT for the end date's id
      // (today's unless a "to" date is set).
      if (!DATE_RE.test(until || '') || until >= puzzleDateToday()) until = '';
      const last = until || puzzleDateToday();
      const top = await nytJson(fetchImpl, `/svc/connections/v2/${last}.json`).catch((err) => {
        throw err.message === 'signed-out' ? err : new Error(`no puzzle found for ${last}`);
      });
      const maxId = Number(top.id);
      if (!Number.isInteger(maxId) || maxId < 1) throw new Error(`no puzzle found for ${last}`);
      if (until && since && DATE_RE.test(since) && since > until)
        throw new Error('the "from" date is after the "to" date');
      // Puzzle ids aren't a count of days: ask NYT for the start date's id.
      let minId = 1;
      if (!DATE_RE.test(since || '') || since < FIRST_PUZZLE) since = '';
      if (since) {
        const first = await nytJson(fetchImpl, `/svc/connections/v2/${since}.json`).catch((err) => {
          throw err.message === 'signed-out' ? err : new Error(`no puzzle found for ${since}`);
        });
        minId = Number(first.id);
        if (!Number.isInteger(minId) || minId < 1 || minId > maxId) throw new Error(`no puzzle found for ${since}`);
      }
      const have = new Set([...mirror.values()].map((e) => e.d).filter(Boolean));
      if (puzzleEntry && puzzleEntry.d) have.add(puzzleEntry.d);
      // Step by the ids this batch covered: lim.size may shrink during it.
      for (let hi = maxId, step = 0; hi >= minId; hi -= step) {
        const ids = [];
        for (let id = hi; id > Math.max(minId - 1, hi - lim.size); id--) ids.push(id);
        step = ids.length;
        setHistStatus(`Importing from NYT: puzzles ${ids[ids.length - 1]}–${hi} (${minId}–${maxId})…`);
        const states = await nytStates(fetchImpl, ids, lim);
        const batch = [];
        for (const st of states) {
          const data = st && (st.data || st.game_data);
          const d = st && (st.printDate || st.print_date);
          if (!data || !DATE_RE.test(d || '') || !(data.guesses || []).length) continue;
          if ((since && d < since) || (until && d > until)) continue;
          if (have.has(d)) {
            sum.had++;
            continue;
          }
          if (!data.puzzleComplete) {
            sum.unfinished++;
            continue;
          }
          let answers;
          try {
            answers = await nytJson(fetchImpl, `/svc/connections/v2/${d}.json`);
          } catch (err) {
            if (err.message === 'signed-out') throw err;
            sum.failed++;
            continue;
          }
          const t = Number(st.timestamp || data.timestamp) || 0;
          const rec = nytRecord(d, data, t > 0 && t < 1e12 ? t * 1000 : t, answers);
          if (!rec) {
            sum.skipped++;
            continue;
          }
          have.add(d);
          batch.push(rec);
          await new Promise((r) => setTimeout(r, 100)); // be gentle with NYT
        }
        if (batch.length) {
          const out = {};
          for (const rec of batch) {
            mirror.set(rec.id, rec);
            out[REC + rec.id] = rec;
          }
          await backend.set(out);
          sum.added += batch.length;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (err) {
      error =
        err && err.message === 'signed-out'
          ? 'Import from NYT: sign in to NYT first'
          : `Import from NYT failed: ${(err && err.message) || err}`;
    } finally {
      importingNyt = false;
    }
    const parts = [`Imported ${sum.added} puzzle${sum.added === 1 ? '' : 's'} from NYT`];
    if (sum.had) parts.push(`${sum.had} already in history`);
    if (sum.unfinished) parts.push(`${sum.unfinished} unfinished left out`);
    if (sum.skipped) parts.push(`${sum.skipped} couldn't be rebuilt`);
    sum.failed += lim.rejected;
    if (sum.failed) parts.push(`${sum.failed} couldn't be fetched`);
    histStatus = !error
      ? parts.join(', ')
      : sum.added
      ? `${error} (${parts.join(', ')} so far)`
      : error;
    renderHistory();
    return { ...sum, error };
  }

  function removeNytImports() {
    const ids = [...mirror.values()].filter((e) => e.nyt).map((e) => e.id);
    for (const id of ids) mirror.delete(id);
    if (ids.length) backend.remove(ids.map((id) => REC + id)).catch(() => {});
    histStatus = `Removed ${ids.length} puzzle${ids.length === 1 ? '' : 's'} imported from NYT`;
    renderHistory();
    return ids.length;
  }

  async function checkHistory() {
    if (checking) return;
    checking = true;
    const sum = { checked: 0, recolored: 0, split: 0, skipped: 0, failed: 0 };
    try {
      await checkRecords(sum);
    } finally {
      checking = false;
    }
    const parts = [`${sum.checked} puzzle${sum.checked === 1 ? '' : 's'} checked`];
    if (sum.recolored) parts.push(`${sum.recolored} tile colors fixed`);
    if (sum.split) parts.push(`${sum.split} mixed-up puzzle${sum.split === 1 ? '' : 's'} split`);
    if (sum.skipped) parts.push(`${sum.skipped} skipped (tiles didn't match)`);
    if (sum.failed) parts.push(`${sum.failed} couldn't be fetched`);
    if (!sum.recolored && !sum.split && sum.checked) parts.push('all good');
    histStatus = parts.join(', ');
    renderHistory();
  }

  async function checkRecords(sum) {
    const recs = readTimes().filter((e) => DATE_RE.test(e.d || ''));
    setHistStatus(`Checking 0 of ${recs.length}…`);
    renderHistory(); // show the disabled button
    for (let i = 0; i < recs.length; i++) {
      setHistStatus(`Checking ${i + 1} of ${recs.length}…`);
      const e = recs[i];
      let ans;
      try {
        ans = await answersFor(e.d);
      } catch (_) {
        sum.failed++;
        continue;
      }
      const inPuzzle = (w) => ans.has(String(w).toUpperCase());
      if (e.tiles.filter(inPuzzle).length < 8) {
        sum.skipped++;
        continue;
      }
      sum.checked++;
      let changed = false;
      // Split off another puzzle's guesses (not for the one being played).
      const foreignTiles = e.tiles.filter((t) => !inPuzzle(t));
      if (foreignTiles.length >= 4 && e !== puzzleEntry) {
        const words = (g) => g.map((x) => (x && typeof x === 'object' ? x.t : x));
        const ours = [];
        const theirs = [];
        for (const g of e.guesses || [])
          (words(g).every(inPuzzle) ? ours : theirs).push(g);
        const other = {
          id: newId(''),
          split: true,
          tiles: foreignTiles,
          ms: 0,
          u: (e.u || 0) - 1,
          started: e.started,
          guesses: theirs.map((g) =>
            g.map((x) =>
              x && typeof x === 'object' && x.s
                ? { ...x, s: expandSnap(x.s, e.css) }
                : x
            )
          ),
        };
        compactRecord(other);
        e.guesses = ours;
        e.tiles = e.tiles.filter(inPuzzle);
        if (Array.isArray(e.words)) e.words = e.words.filter(inPuzzle);
        if (e.tags)
          e.tags = Object.fromEntries(Object.entries(e.tags).filter(([w]) => inPuzzle(w)));
        writeTimes(other);
        sum.split++;
        changed = true;
      }
      // Colors give away the answers, so only finished puzzles get them —
      // never one that's still in progress (here or saved for later).
      const inProgress = e === puzzleEntry && !clockFrozen;
      const finished = !!e.completed && !inProgress;
      for (const g of finished ? e.guesses || [] : [])
        for (const x of g) {
          if (!x || typeof x !== 'object') continue;
          const c = ans.get(String(x.t).toUpperCase());
          if (c && x.correct !== c) {
            x.correct = c;
            delete x.tries;
            sum.recolored++;
            changed = true;
          }
        }
      if (changed) writeTimes(e);
      await new Promise((r) => setTimeout(r, 120)); // be gentle with NYT
    }
  }

  // Win/loss and mistakes, worked out from the guesses once every guessed
  // tile's category is known: 4 correct groups = won, 4 wrong guesses =
  // lost. ("Already guessed" repeats are never stored.) null = unfinished
  // or not enough information (e.g. very old records).
  function resultOf(e) {
    const gs = (e.guesses || []).filter((g) => g.length === 4);
    if (!gs.length) return null;
    const known = gs.every((g) =>
      g.every((x) => x && typeof x === 'object' && TAG_COLORS.includes(x.correct))
    );
    if (!known) return null;
    const solved = gs.filter((g) => g.every((x) => x.correct === g[0].correct)).length;
    const mistakes = gs.length - solved;
    if (solved >= 4) return { won: true, mistakes };
    if (mistakes >= 4) return { won: false, mistakes };
    return null;
  }

  function historyStats(list = readTimes()) {
    const done = list
      .map((e) => ({ e, r: resultOf(e) }))
      .filter((x) => x.r);
    const wins = done.filter((x) => x.r.won);
    const times = wins.map((x) => x.e.ms).filter((ms) => ms > 0);
    // Streak: wins in a row in the order the puzzles were finished,
    // counting back from the most recent one — archive puzzles are often
    // played out of date order, so puzzle dates can't define a streak.
    const byFinish = done
      .slice()
      .sort((a, b) => (b.e.completed || b.e.u || 0) - (a.e.completed || a.e.u || 0));
    let streak = 0;
    while (streak < byFinish.length && byFinish[streak].r.won) streak++;
    // Solving order. firstOf: the color of the first guess when it was a
    // correct group; order: the colors of the solved groups in order.
    const firstOf = (e) => {
      const g = (e.guesses || []).find((x) => x.length === 4);
      return g && g.every((x) => x.correct === g[0].correct) ? g[0].correct : null;
    };
    const orderOf = (e) =>
      (e.guesses || [])
        .filter((g) => g.length === 4 && g.every((x) => x.correct === g[0].correct))
        .map((g) => g[0].correct)
        .join();
    return {
      // First guess was the purple group.
      purpleFirst: done.filter((x) => firstOf(x.e) === 'purple').length,
      // Groups solved purple, blue, green, yellow (mistakes in between ok).
      reverseRainbow: done.filter((x) => orderOf(x.e) === 'purple,blue,green,yellow').length,
      // First guess was the group the fewest players solved first
      // (Connections Bot; e.rare, filled in by fillRare).
      rarestFirst: done.filter((x) => x.e.rare && firstOf(x.e) === x.e.rare).length,
      played: done.length,
      won: wins.length,
      winPct: done.length ? Math.round((100 * wins.length) / done.length) : 0,
      perfect: wins.filter((x) => x.r.mistakes === 0).length,
      avgMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      bestMs: times.length ? Math.min(...times) : 0,
      streak,
    };
  }

  // Extra facts for finished puzzles, filled in once in the background
  // (one puzzle at a time; failures are retried on the next page load):
  // - e.cats: category names by color, from NYT's answers file (only once
  //   a puzzle is finished: names reveal answers).
  // - From Connections Bot's public per-puzzle summary, for puzzles dated
  //   before today (today's numbers still move): e.first, the % of winners
  //   who solved each group first (firstColor, by level 0 yellow ... 3
  //   purple; a difficulty hint), e.rare, the least common one, and
  //   e.wrong, the % of games (out of `complete`, a sample of games) with
  //   each of this player's wrong guesses (mistakenGuesses, keyed by the
  //   sorted card positions in the answers file; that list is complete,
  //   so a missing guess means 0).
  const BOT_SUMMARY = (d) =>
    `https://static01.nyt.com/newsgraphics/2024/connections-bot/game/${d}-summary.json`;
  const itemWord = (x) => String(x && typeof x === 'object' ? x.t || '' : x || '').trim().toUpperCase();
  // A guess's identity in e.wrong: its words, sorted.
  const guessWordsKey = (g) => g.map(itemWord).sort().join('|');
  const isCorrectGuess = (g) =>
    g.length === 4 &&
    g.every((x) => x && typeof x === 'object' && TAG_COLORS.includes(x.correct) && x.correct === g[0].correct);
  let fillingRare = false;
  const rareTried = new Set();
  async function fillRare(fetchImpl = pageFetch) {
    if (fillingRare) return 0;
    fillingRare = true;
    let added = 0;
    const json = async (url) => {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    try {
      const today = puzzleDateToday();
      const todo = [...mirror.values()].filter((e) => {
        if (!DATE_RE.test(e.d || '') || rareTried.has(e.id) || !resultOf(e)) return false;
        return !e.cats || (e.d < today && (!e.first || !e.wrong));
      });
      for (const e of todo) {
        rareTried.add(e.id);
        try {
          const answers = await json(`/svc/connections/v2/${e.d}.json`);
          const cats = {};
          const pos = new Map();
          (answers.categories || []).forEach((c, i) => {
            if (c && c.title) cats[TAG_COLORS[i]] = String(c.title).slice(0, 200);
            ((c && c.cards) || []).forEach((x) => {
              const w = String(x.content || x.image_alt_text || '').trim().toUpperCase();
              if (w && Number.isInteger(x.position)) pos.set(w, x.position);
            });
          });
          let bot = null;
          if (e.d < today && (!e.first || !e.wrong)) {
            try {
              bot = await json(BOT_SUMMARY(e.d));
            } catch (_) {}
          }
          const live = mirror.get(e.id);
          if (!live) continue; // deleted meanwhile
          let changed = false;
          if (Object.keys(cats).length === 4 && !live.cats) {
            live.cats = cats;
            changed = true;
          }
          if (bot) {
            const fc = bot.firstColor || {};
            const counts = [0, 1, 2, 3].map((k) => Number(fc[k]));
            const total = counts.reduce((a, b) => a + b, 0);
            if (counts.every((n) => Number.isFinite(n) && n >= 0) && total) {
              live.first = {};
              counts.forEach((n, k) => (live.first[TAG_COLORS[k]] = Math.round((1000 * n) / total) / 10));
              const min = Math.min(...counts);
              if (counts.filter((n) => n === min).length === 1) live.rare = TAG_COLORS[counts.indexOf(min)];
              changed = true;
            }
            const games = Number(bot.complete) || 0;
            const mg = bot.mistakenGuesses;
            if (games > 0 && mg && typeof mg === 'object' && pos.size === 16) {
              const wrong = {};
              for (const g of live.guesses || []) {
                if (g.length !== 4 || isCorrectGuess(g)) continue;
                const ps = g.map((x) => pos.get(itemWord(x)));
                if (!ps.every(Number.isInteger)) continue;
                const n = Number(mg[ps.sort((a, b) => a - b).join(',')]) || 0;
                wrong[guessWordsKey(g)] = Math.round((1000 * n) / games) / 10;
              }
              live.wrong = wrong;
              changed = true;
            }
          }
          if (changed) {
            writeTimes(live);
            added++;
          }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 150)); // be gentle with NYT
      }
    } finally {
      fillingRare = false;
    }
    if (added && histPanel) renderHistory();
    return added;
  }

  // Rebuild the panel without disturbing the reader: re-renders happen
  // mid-game (new guesses, category reveals), so keep the scroll position
  // and the search box's focus/caret across them.
  // Guesses saved before 1.8 kept only a tile's word and inner HTML
  // ({t, h}) or just the word, not its box. NYT's text tiles all share one
  // box, so those are drawn inside a tile that was saved in full (or, with
  // none saved yet, one on the board now), with the old tile's word and its
  // NYT shrink-to-fit font size. Picture tiles keep their own markup.
  let tileTemplate; // undefined = not looked up since the last render
  const NYT_TILE_HTML =
    '<div data-cw-tile style="box-sizing:border-box;width:150px;height:80px;padding:0px;' +
    'border-radius:6px;overflow:hidden;position:relative;font-family:nyt-franklin, Arial;' +
    'font-size:20px;font-weight:700;font-style:normal;line-height:25px;letter-spacing:normal;' +
    'word-spacing:0px;text-transform:uppercase;text-align:center;white-space:normal;' +
    'word-break:normal;overflow-wrap:normal;display:flex;flex-wrap:wrap;place-content:center">' +
    '<span style="display:block">X</span></div>';
  function textTemplate(html, w, css) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root || root.querySelector('img, svg, canvas, video')) return null;
    if (root.children.length !== 1 || root.children[0].children.length) return null;
    return { html, w, css };
  }
  function findTileTemplate() {
    // The widest saved text tile (the desktop board; a tile saved in a
    // narrow window would wrap words NYT's desktop tiles keep on one line),
    // the newest one among equals.
    const recs = [...mirror.values()].sort((a, b) => (b.u || 0) - (a.u || 0));
    let best = null;
    for (const e of recs)
      for (const g of e.guesses || [])
        for (const x of g)
          if (x && typeof x === 'object' && x.s && x.w && (!best || x.w > best.w)) {
            const t = textTemplate(x.s, x.w, e.css);
            if (t) best = t;
          }
    const card = getCards()[0];
    if (card) {
      const snap = snapshotTile(card);
      const live = textTemplate(snap.html, snap.w, null);
      if (live && (!best || live.w > best.w)) best = live;
    }
    // Nothing saved in full and no tile on the board (e.g. the puzzle is
    // finished): NYT's desktop tile, as its computed styles read on the live
    // board (Card-module_label; 2026-11).
    return best || { html: NYT_TILE_HTML, w: 150, css: null };
  }
  // A replica of an old text tile, or null when no template exists.
  // img: a picture to draw in the tile instead of the text (picture
  // puzzles imported from NYT, or pre-1.8 picture tiles).
  function oldTileReplica(text, h, img) {
    if (tileTemplate === undefined) tileTemplate = findTileTemplate();
    if (!tileTemplate) return null;
    const frag = safeTileNodes(tileTemplate.html, tileTemplate.css);
    const root = frag.firstElementChild;
    const leaf = root && root.firstElementChild;
    if (!leaf) return null;
    if (img) {
      leaf.textContent = '';
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.alt = img.alt || text;
      img.className = 'cw-pic';
      // Like NYT's own picture card (Card-module_svgContainer: the image
      // centered in the full card). Sized in px: the tile's inner span
      // shrinks to its content, so percentages collapse it to nothing.
      const hgt = parseFloat(root.style.height) || 0;
      const wid = parseFloat(root.style.width) || 0;
      img.style.cssText =
        'display:block;margin:auto;width:auto;object-fit:contain;' +
        (hgt ? `height:${Math.round(hgt)}px;` : 'height:4em;') +
        (wid ? `max-width:${Math.round(wid)}px;` : '');
      leaf.appendChild(img);
      leaf.style.fontSize = '';
      return { node: root, w: tileTemplate.w };
    }
    leaf.textContent = text;
    leaf.style.textAlign = 'center'; // NYT centers tile text (older saves lack it)
    // NYT shrinks long words with an inline font-size on the visible span:
    // the saved one when the old tile kept it, else worked out the same way.
    const sizes = [...String(h || '').matchAll(/font-size:\s*([\d.]+(?:em|px|%))/gi)];
    leaf.style.fontSize = sizes.length ? sizes[sizes.length - 1][1] : nytFitEm(text, root);
    return { node: root, w: tileTemplate.w };
  }

  // NYT's shrink-to-fit for tile text (Card component): a hidden absolute
  // copy of the text is as wide as its longest word or the tile, but no
  // wider than the text on one line; past 90% of the tile width the font
  // scales by 0.9 * tile / that width. Measured with a canvas in the tile's
  // font, so it works before the tile is on screen.
  let fitCanvas;
  function nytFitEm(text, root) {
    const W = parseFloat(root.style.width) || 0;
    if (!W || !text) return '';
    const st = root.style;
    fitCanvas = fitCanvas || document.createElement('canvas');
    const ctx = fitCanvas.getContext('2d');
    ctx.font = `${st.fontStyle || 'normal'} ${st.fontWeight || '700'} ${st.fontSize || '20px'} ${st.fontFamily || 'sans-serif'}`;
    const t = st.textTransform === 'uppercase' ? text.toUpperCase() : text;
    const maxC = ctx.measureText(t).width;
    const minC = Math.max(...t.split(/\s+/).map((w) => ctx.measureText(w).width));
    const ref = Math.min(Math.max(minC, W), maxC);
    return ref > 0.9 * W ? `${((0.9 * W) / ref).toFixed(3)}em` : '1em';
  }

  function renderHistory() {
    tileTemplate = undefined;
    if (!histPanel) return;
    const scroll = histPanel.scrollTop;
    const a = document.activeElement;
    const caret =
      a && a.type === 'search' && histPanel.contains(a)
        ? [a.selectionStart, a.selectionEnd]
        : null;
    buildHistory();
    filterRows();
    histPanel.scrollTop = scroll;
    if (caret) {
      const search = histPanel.querySelector('input[type="search"]');
      if (search) {
        search.focus({ preventScroll: true });
        search.setSelectionRange(caret[0], caret[1]);
      }
    }
  }

  function buildHistory() {
    if (!histPanel) return;
    tileFit.disconnect();
    histPanel.textContent = '';
    syncTileColors();
    const head = document.createElement('div');
    head.setAttribute('data-cw-hist-head', '');
    const title = document.createElement('span');
    title.textContent = 'History';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'clear';
    clear.title = 'Clear history';
    clear.addEventListener('click', () => confirmClear(clear));
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', toggleHistory);
    const exp = document.createElement('button');
    exp.type = 'button';
    exp.textContent = 'export';
    exp.title = 'Save your history to a file';
    exp.addEventListener('click', () => {
      const n = exportHistory();
      histStatus = `Exported ${n} puzzle${n === 1 ? '' : 's'}`;
      renderHistory();
    });
    const imp = document.createElement('button');
    imp.type = 'button';
    imp.textContent = 'import';
    imp.title = 'Merge history from a file';
    const impInput = importInput();
    imp.addEventListener('click', () => impInput.click());
    head.append(title);
    const tools = document.createElement('div');
    tools.className = 'tools';
    tools.append(exp, imp, clear, impInput);
    // Debug menu (⋯): maintenance tools kept out of reach of a stray click
    // while solving.
    const dbgBtn = document.createElement('button');
    dbgBtn.type = 'button';
    dbgBtn.className = 'dbg-toggle';
    dbgBtn.textContent = '⋯';
    dbgBtn.title = 'Debug tools';
    dbgBtn.setAttribute('aria-expanded', String(histDebugOpen));
    dbgBtn.addEventListener('click', () => {
      histDebugOpen = !histDebugOpen;
      renderHistory();
    });
    head.append(dbgBtn, close);
    histPanel.appendChild(head);

    const sWrap = document.createElement('div');
    sWrap.className = 'searchwrap';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'search';
    search.value = histQuery;
    search.addEventListener('input', () => {
      histQuery = search.value;
      filterRows();
    });
    sWrap.appendChild(search);
    histPanel.appendChild(sWrap);
    histPanel.appendChild(tools);
    if (histDebugOpen) histPanel.appendChild(debugMenu());
    const stats = historyStats();
    if (stats.played) {
      const box = document.createElement('div');
      box.className = 'stats';
      [
        [stats.played, 'played'],
        [`${stats.winPct}%`, 'won'],
        [stats.perfect, 'perfect'],
        [stats.avgMs ? fmtClock(stats.avgMs) : '–', 'avg win'],
        [stats.bestMs ? fmtClock(stats.bestMs) : '–', 'best'],
        [stats.streak, 'streak'],
        [stats.purpleFirst, 'purple first', 'First guess was the purple group'],
        [stats.reverseRainbow, 'rev. rainbow', 'Groups solved purple → blue → green → yellow'],
        [stats.rarestFirst, 'rarest first',
          'First guess was the group the fewest players solved first (Connections Bot data, ' +
          "added for past puzzles; today's counts tomorrow)"],
      ].forEach(([v, label, tip]) => {
        const cell = document.createElement('div');
        if (tip) cell.title = tip;
        const b = document.createElement('b');
        b.textContent = String(v);
        const sm = document.createElement('span');
        sm.textContent = label;
        cell.append(b, sm);
        box.appendChild(cell);
      });
      histPanel.appendChild(box);
    }
    if (histStatus) {
      const st = document.createElement('div');
      st.className = 'status';
      st.textContent = histStatus;
      histPanel.appendChild(st);
    }

    // Every puzzle, most recently played first (history is unlimited; rows
    // are cheap because guess tiles are only built when a row is opened).
    const entries = readTimes()
      .slice()
      .sort((a, b) => b.u - a.u);
    if (!entries.length) {
      const row = document.createElement('div');
      row.setAttribute('data-cw-hist-row', '');
      row.className = 'empty';
      row.textContent = 'No puzzles yet';
      histPanel.appendChild(row);
      return;
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.setAttribute('data-cw-hist-row', '');
      const left = document.createElement('div');
      left.className = 'left';
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = e.d
        ? fmtDate(e.d)
        : e.split
        ? 'Unknown date'
        : fmtDate(null, e.u);
      left.appendChild(date);
      if (e === puzzleEntry) {
        row.classList.add('current');
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'playing';
        date.appendChild(badge);
      }
      const res = resultOf(e);
      if (res) {
        const r = document.createElement('span');
        r.className = `result ${res.won ? 'won' : 'lost'}`;
        r.textContent = res.won
          ? res.mistakes
            ? `✓ ${res.mistakes} mistake${res.mistakes === 1 ? '' : 's'}`
            : '✓ perfect'
          : '✗ lost';
        date.appendChild(r);
      }
      if (e.started || e.completed) {
        const tl = document.createElement('div');
        tl.className = 'times';
        // The day it was played (archive puzzles are often played on other
        // days), then the start and finish times.
        const day = (ts) => fmtDate(null, ts);
        const sameDay = !(e.started && e.completed) || day(e.started) === day(e.completed);
        tl.textContent =
          `${day(e.started || e.completed)}, ` +
          [
            e.started && fmtTime(e.started),
            e.completed && (sameDay ? '' : `${day(e.completed)}, `) + fmtTime(e.completed),
          ]
            .filter(Boolean)
            .join(' – ') +
          (e.nyt ? ' · from NYT' : '');
        left.appendChild(tl);
      }
      // A puzzle's guess tiles are only built when its row is expanded, so
      // the panel stays fast with a long history.
      let guessesBuilt = false;
      const buildGuesses = () => {
        if (guessesBuilt || !(e.guesses && e.guesses.length)) return;
        guessesBuilt = true;
        const g = document.createElement('div');
        g.className = 'guesses';
        for (const guess of e.guesses) {
          const gRow = document.createElement('div');
          gRow.className = 'guess';
          // Border only when every tile is the same category (a correct
          // guess); chips carry per-tile colors either way.
          const cols = guess.map((x) =>
            x && typeof x === 'object' ? x.correct : null
          );
          if (cols.every((c) => c && c === cols[0] && c !== 'solved'))
            gRow.dataset.color = cols[0];
          guess.forEach((w) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            // Replica scaled to the cell (zoom kept current by tileFit).
            const replica = (node, width) => {
              chip.classList.add('replica');
              chip.dataset.w = width;
              chip.appendChild(node);
              if (cellWidth && chip.firstElementChild)
                chip.firstElementChild.style.zoom = String(cellWidth / width);
              tileFit.observe(chip);
            };
            const obj = w && typeof w === 'object';
            const media = obj && w.h && /<(img|svg|canvas|video)/i.test(w.h);
            // A picture tile saved as just its image (NYT import, or an old
            // picture tile with an <img>): draw it in a full tile.
            const pic = media && !(w.s && w.w) && /<img/i.test(w.h)
              ? safeTileNodes(w.h, e.css).querySelector('img[src]')
              : null;
            const old = obj && w.s && w.w ? null
              : pic ? oldTileReplica(w.t || '', null, pic)
              : !media && oldTileReplica(obj ? w.t || '' : String(w || ''), obj && w.h);
            if (obj && w.s && w.w) {
              // Exact replica captured at Submit time.
              replica(safeTileNodes(w.s, e.css), w.w);
            } else if (old) {
              replica(old.node, old.w);
            } else if (media) {
              // Old picture tile: its own inner markup.
              chip.appendChild(safeTileNodes(w.h, e.css));
            } else {
              chip.textContent = obj ? w.t || '' : w || '';
            }
            if (obj && w.correct && w.correct !== 'solved')
              chip.dataset.color = w.correct;
            gRow.appendChild(chip);
          });
          // One line under the tiles. Correct group: its category name and
          // the share of winners who solved it first (Connections Bot; a
          // difficulty hint: the easiest group usually goes first). Wrong
          // guess: "One away", and the share of games with this guess.
          const pctTxt = (p) => `${p < 1 ? '<1' : Math.round(p)}%`;
          const parts = [];
          const tips = [];
          const col = gRow.dataset.color;
          if (col) {
            if (e.cats && e.cats[col]) {
              // The category name heads the group, like NYT's solved rows.
              const cat = document.createElement('span');
              cat.className = 'cat';
              cat.textContent = e.cats[col];
              gRow.prepend(cat);
            }
            const pct = e.first && e.first[col];
            if (typeof pct === 'number') {
              parts.push(`first for ${pctTxt(pct)}`);
              tips.push(
                `${pct}% of winners solved this group first (Connections Bot). ` +
                  'The group most people find first is usually the easiest.'
              );
            }
          } else {
            if (isOneAway(guess)) {
              gRow.classList.add('one-away');
              parts.push('One away');
            }
            const wp = e.wrong && e.wrong[guessWordsKey(guess)];
            if (typeof wp === 'number') {
              parts.push(`made by ${pctTxt(wp)}`);
              tips.push(`${wp}% of players made this exact guess (Connections Bot).`);
            }
          }
          if (parts.length) {
            const note = document.createElement('span');
            note.className = 'note';
            if (col && e.first && typeof e.first[col] === 'number') note.classList.add('pct');
            note.textContent = parts.join(' · ');
            if (tips.length) note.title = tips.join(' ');
            gRow.appendChild(note);
          }
          g.appendChild(gRow);
        }
        left.appendChild(g);
      };
      const time = document.createElement('span');
      time.className = 'meta';
      // The current puzzle's row shows the live clock, not the last-saved ms
      // (which lags by up to ~5s and made the display bounce on re-renders).
      time.textContent =
        e === puzzleEntry && clockStart
          ? fmtClock(baseMs + (clockFrozen || Date.now()) - clockStart)
          : (e.split || e.nyt) && !e.ms
          ? '–' // split-off record: its time stayed with the original
          : fmtClock(e.ms);
      if (e === puzzleEntry) time.setAttribute('data-cw-hist-current', '');
      if (e.guesses && e.guesses.length) {
        row.classList.add('has-guesses');
        const chev = document.createElement('span');
        chev.className = 'chev';
        date.prepend(chev);
        // Expanded state survives re-renders (guesses/marks trigger them).
        const sig = (e.tiles || e.words || []).join(',');
        if (histOpen.has(sig)) {
          row.classList.add('open');
          buildGuesses();
        }
        row.addEventListener('click', () => {
          row.classList.toggle('open');
          if (row.classList.contains('open')) {
            histOpen.add(sig);
            buildGuesses();
          } else histOpen.delete(sig);
        });
        const cp = document.createElement('button');
        cp.className = 'copy';
        cp.type = 'button';
        cp.title = 'Copy results';
        cp.textContent = '⧉';
        cp.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const EMOJI = {
            yellow: '🟨',
            green: '🟩',
            blue: '🟦',
            purple: '🟪',
          };
          const lines = e.guesses
            .map((g) =>
              g.map((x) => EMOJI[(x && x.correct) || ''] || '⬜').join('')
            )
            .join('\n');
          const head = `Connections${e.d ? `\n${fmtDate(e.d)}` : ''}`;
          if (navigator.clipboard)
            navigator.clipboard.writeText(`${head}\n${lines}`);
          cp.textContent = '✓';
          setTimeout(() => (cp.textContent = '⧉'), 1200);
        });
        row.appendChild(cp);
      }
      row.append(left, time);
      // One entry per line (date, each tile, each category name): a query
      // matches inside one entry only, so "big a" never spans BIG + AIRPLANE.
      // The search box can't hold a line break.
      row.dataset.search = [
        date.textContent,
        ...(e.tiles || []),
        ...(e.words || []),
        ...(e.guesses || []).flat().map((x) => (x && typeof x === 'object' ? x.t : x)),
        ...Object.values(e.cats || {}),
      ]
        .filter((x) => typeof x === 'string' && x)
        .join('\n')
        .toLowerCase();
      if (e !== puzzleEntry && e.id) {
        const del = document.createElement('button');
        del.className = 'del';
        del.type = 'button';
        del.title = 'Delete this puzzle from history';
        del.textContent = '✕';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          confirmAction(del, `Delete ${date.firstChild ? date.firstChild.textContent : 'this puzzle'}?`, 'delete', () => {
            deleteRecord(e.id);
            renderHistory();
          });
        });
        row.appendChild(del);
      }
      if (DATE_RE.test(e.d || '')) {
        const vb = document.createElement('button');
        vb.className = 'view';
        vb.type = 'button';
        vb.title = 'Open this puzzle';
        vb.textContent = '↗';
        vb.addEventListener('click', (ev) => {
          ev.stopPropagation();
          location.href = `/games/connections/${e.d}`;
        });
        row.appendChild(vb);
      }
      histPanel.appendChild(row);
    }
  }

  // Mark guesses that turned out to be correct categories: find solved-group
  // rows by their computed background color (matched to the four category
  // colors) and stamp every tile of the matching guess with that color.
  const GROUP_RGBS = {
    yellow: [249, 223, 109],
    green: [160, 195, 90],
    blue: [176, 196, 239],
    purple: [186, 129, 197],
  };
  // Nearest category color of the first non-transparent background at or
  // above el ('' when nothing matches).
  function colorOfBg(el) {
    for (
      let d = 0;
      el && el.nodeType === 1 && d < 6;
      d++, el = el.parentElement
    ) {
      const m = (getComputedStyle(el).backgroundColor || '').match(
        /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/
      );
      if (!m) continue;
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (alpha < 0.1) continue;
      const rgb = [+m[1], +m[2], +m[3]];
      return (
        Object.keys(GROUP_RGBS).find((c) => nearRgb(rgb, GROUP_RGBS[c])) || ''
      );
    }
    return '';
  }

  // Map tile text -> its category color, from the solved rows on the page.
  function tileColors(guessTexts) {
    const map = new Map();
    document
      .querySelectorAll('[data-testid="solved-category-container"]')
      .forEach((sec) => {
        const color = colorOfBg(sec);
        if (!color) return;
        sec
          .querySelectorAll('[data-testid="solved-category-card"]')
          .forEach((li) => {
            const img = li.querySelector('img');
            const t = (img && img.alt ? img.alt : li.textContent)
              .trim()
              .toUpperCase();
            if (t) map.set(t, color);
          });
      });
    if (map.size || !guessTexts) return map;
    // Fallback for boards without the NYT testids (harness): any wide,
    // category-colored element whose text contains a tile claims it.
    // Tiles themselves never count: color tags paint them in the category
    // colors, and reading those back would save the player's own guesses
    // as answers. Nor does anything of ours (toolbar, history panel).
    const root = (barHost && barHost.el) || document.body;
    const cards = getCards();
    const ours = '[data-cw-bar], [data-cw-history-panel]';
    for (const el of root.querySelectorAll('*')) {
      if (cards.some((c) => c === el || c.contains(el) || el.contains(c))) continue;
      if (el.closest(ours)) continue;
      const color = colorOfBg(el);
      if (!color || el.getBoundingClientRect().width < 100) continue;
      const text = el.textContent.toUpperCase();
      for (const t of guessTexts) {
        if (!map.has(t) && text.includes(t)) map.set(t, color);
      }
    }
    return map;
  }

  // Stamp each guessed tile with the color of the category it actually
  // belongs to — per-tile, so mixed guesses show their real composition.
  function markGuesses() {
    const guesses = puzzleEntry && puzzleEntry.guesses;
    if (!guesses || !guesses.length) return;
    const pending = guesses.filter((g) => {
      const items = g.filter((x) => x && typeof x === 'object');
      if (!items.length) return false;
      if (items.every((x) => x.correct && x.correct !== 'solved'))
        return false;
      return (items[0].tries || 0) <= 60;
    });
    if (!pending.length) return;
    const texts = new Set(
      pending.flat().map((x) => (x.t || '').toUpperCase()).filter(Boolean)
    );
    const map = tileColors(texts);
    if (!map.size) return;
    let changed = false;
    for (const g of pending) {
      const items = g.filter((x) => x && typeof x === 'object');
      let gained = false;
      for (const x of items) {
        const c = map.get((x.t || '').toUpperCase());
        if (c && x.correct !== c) {
          x.correct = c;
          changed = true;
          gained = true;
        }
      }
      // Only burn a retry when rows exist but this guess gained nothing —
      // early guesses must keep waiting for their categories to reveal.
      if (!gained) items[0].tries = (items[0].tries || 0) + 1;
    }
    if (changed) {
      writeTimes();
      if (histPanel) renderHistory();
    }
  }

  // Small popover anchored to the clear button: red confirm, plain cancel.
  let confirmPop = null;
  let confirmAnchor = null;
  function closeConfirm() {
    if (confirmPop) confirmPop.remove();
    confirmPop = null;
    confirmAnchor = null;
  }

  function positionConfirm() {
    if (!confirmPop) return;
    if (!confirmAnchor || !confirmAnchor.isConnected) {
      closeConfirm();
      return;
    }
    const r = confirmAnchor.getBoundingClientRect();
    const w = confirmPop.offsetWidth || 190;
    const h = confirmPop.offsetHeight || 80;
    // Prefer popping out to the LEFT of the sidebar with a right-pointing
    // arrow; fall back to below the button if it doesn't fit.
    if (r.left - w - 14 >= 8) {
      confirmPop.dataset.side = 'left';
      confirmPop.style.left = `${r.left - w - 14}px`;
      const top = Math.max(
        8,
        Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8)
      );
      confirmPop.style.top = `${top}px`;
      const ay = Math.max(
        12,
        Math.min(r.top + r.height / 2 - top, h - 12)
      );
      confirmPop.style.setProperty('--arrow-y', `${ay}px`);
    } else {
      confirmPop.dataset.side = 'below';
      const left = Math.max(
        8,
        Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)
      );
      confirmPop.style.left = `${left}px`;
      confirmPop.style.top = `${r.bottom + 8}px`;
      const ax = Math.max(12, Math.min(r.left + r.width / 2 - left, w - 12));
      confirmPop.style.setProperty('--arrow-x', `${ax}px`);
    }
  }

  function confirmClear(anchor) {
    confirmAction(anchor, 'Clear all history?', 'clear', () => {
      clearRecords();
      renderHistory();
    });
  }

  function confirmAction(anchor, message, yesLabel, onYes) {
    closeConfirm();
    const pop = document.createElement('div');
    pop.setAttribute('data-cw-confirm', '');
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = message;
    const btns = document.createElement('div');
    btns.className = 'btns';
    const yes = document.createElement('button');
    yes.className = 'yes';
    yes.textContent = yesLabel;
    const no = document.createElement('button');
    no.className = 'no';
    no.textContent = 'cancel';
    yes.addEventListener('click', () => {
      closeConfirm();
      onYes();
    });
    no.addEventListener('click', closeConfirm);
    btns.append(yes, no);
    pop.append(msg, btns);
    document.body.appendChild(pop);
    confirmPop = pop;
    confirmAnchor = anchor;
    positionConfirm();
  }

  let histQuery = '';
  let histDebugOpen = false; // debug menu (⋯) expanded

  function debugMenu() {
    const box = document.createElement('div');
    box.className = 'debug';
    const h = document.createElement('div');
    h.className = 'debug-title';
    h.textContent = 'Debug tools';
    const chk = document.createElement('button');
    chk.type = 'button';
    chk.textContent = checking ? 'checking…' : 'check history';
    chk.disabled = checking;
    chk.addEventListener('click', checkHistory);
    const chkNote = document.createElement('div');
    chkNote.className = 'debug-note';
    chkNote.textContent =
      "Compares finished puzzles with NYT's answers: fixes guess colors and " +
      'splits puzzles that older versions mixed together. Unfinished puzzles ' +
      'only get split, never colored, so nothing is spoiled.';
    const hud = document.createElement('button');
    hud.type = 'button';
    hud.textContent = DEBUG.on ? 'hide debug overlay' : 'show debug overlay';
    hud.addEventListener('click', () => {
      window.__cw.debug(!DEBUG.on);
      renderHistory();
    });
    const imp = document.createElement('button');
    imp.type = 'button';
    imp.textContent = importingNyt ? 'importing…' : 'import from NYT';
    imp.disabled = importingNyt;
    imp.addEventListener('click', () => importFromNyt());
    const sinceRow = document.createElement('label');
    sinceRow.className = 'debug-since';
    sinceRow.append('from ');
    const since = document.createElement('input');
    since.type = 'date';
    since.min = FIRST_PUZZLE;
    since.max = puzzleDateToday();
    since.value = nytSinceDate();
    since.disabled = importingNyt;
    since.setAttribute('data-cw-nyt-since', '');
    since.addEventListener('change', () => (nytSince = since.value));
    sinceRow.append(since);
    const untilRow = document.createElement('label');
    untilRow.className = 'debug-since';
    untilRow.append('to ');
    const until = document.createElement('input');
    until.type = 'date';
    until.min = FIRST_PUZZLE;
    until.max = puzzleDateToday();
    until.value = nytUntil;
    until.disabled = importingNyt;
    until.setAttribute('data-cw-nyt-until', '');
    until.addEventListener('change', () => (nytUntil = until.value));
    untilRow.append(until);
    const impNote = document.createElement('div');
    impNote.className = 'debug-note';
    impNote.textContent =
      'Adds finished puzzles saved to your NYT account that are not in the ' +
      "history yet: guesses and result, but no time (NYT doesn't keep it). " +
      'Only puzzles from the "from" date (empty = all, back to 2023) to the ' +
      '"to" date (empty = today). ' +
      'Needs you signed in to NYT.';
    const impRow = document.createElement('div');
    impRow.className = 'debug-row';
    impRow.append(imp, sinceRow, untilRow);
    box.append(h, chk, chkNote, impRow, impNote);
    if (puzzleEntry && !puzzleEntry.completed) {
      const rst = document.createElement('button');
      rst.type = 'button';
      rst.textContent = 'reset clock';
      rst.setAttribute('data-cw-reset-clock', '');
      rst.addEventListener('click', () =>
        confirmAction(rst, 'Reset the clock for this puzzle to 0:00?', 'reset', resetClock)
      );
      const rstNote = document.createElement('div');
      rstNote.className = 'debug-note';
      rstNote.textContent =
        "Sets the puzzle you're playing back to 0:00. Guesses, tile order and colors stay.";
      box.append(rst, rstNote);
    }
    const nNyt = [...mirror.values()].filter((e) => e.nyt).length;
    if (nNyt && !importingNyt) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = `remove NYT imports (${nNyt})`;
      rm.addEventListener('click', () =>
        confirmAction(rm, `Remove ${nNyt} imported puzzle${nNyt === 1 ? '' : 's'}?`, 'remove', removeNytImports)
      );
      box.append(rm);
    }
    box.append(hud);
    return box;
  }
  // One-line result of the last export/import, shown under the search box.
  let histStatus = '';
  const histOpen = new Set(); // expanded row signatures, kept across renders
  function filterRows() {
    if (!histPanel) return;
    const q = histQuery.trim().toLowerCase();
    histPanel.querySelectorAll('[data-cw-hist-row]').forEach((row) => {
      row.style.display =
        !q || (row.dataset.search || '').includes(q) ? '' : 'none';
    });
  }

  function toggleHistory() {
    if (histPanel) {
      histPanel.remove();
      histPanel = null;
      histStatus = '';
      histDebugOpen = false;
      closeConfirm();
      return;
    }
    histPanel = document.createElement('div');
    histPanel.setAttribute('data-cw-history-panel', '');
    renderHistory();
    document.body.appendChild(histPanel);
    filterRows();
    // Fill in Connections Bot data for the "rarest first" counter (only on
    // NYT; the offline harness tests it with a mock via __cw.fillRare).
    if (/(^|\.)nytimes\.com$/.test(location.hostname)) fillRare();
  }

  let saveTick = 0;
  let emptyTicks = 0;
  let emptySince = 0; // when the board last went empty
  let lastSubmitAt = 0; // time of the latest Submit click
  let prevEmpty = true; // board was empty at the previous tick
  function tickClock() {
    if (!ui || !storeReady) return;
    const cards = getCards();
    if (cards.length) {
      // Restart only on a real empty -> populated transition (or first run),
      // so a hidden-tab freeze doesn't get mistaken for a new board. Also
      // when a different puzzle replaced this one without a long empty gap
      // (in-app navigation): tile keys are positional (inner-card-N), so
      // the old tags/order would otherwise land on the new puzzle's tiles.
      if (!clockStart || (clockFrozen && prevEmpty)) resolvePuzzle(cards);
      else if (puzzleChanged(cards)) {
        saveTime();
        resolvePuzzle(cards);
      }
      prevEmpty = false;
      emptyTicks = 0;
      emptySince = 0;
    } else {
      prevEmpty = true;
      emptySince = emptySince || Date.now();
      if (clockStart && !clockFrozen && ++emptyTicks >= 3) {
        // React briefly unmounts the grid during re-renders; only freeze
        // once the board has actually been empty for ~1.5s.
        // The tiles are gone. If the board itself is still on the page, the
        // game is over (won or lost): stop the clock at the Submit that
        // ended it — the reveal animation and this check come after it —
        // and mark the puzzle finished. If the board is gone too, the
        // player navigated away mid-game: stop the clock when the tiles
        // vanished, and don't mark it finished (they may come back).
        const gameOver = !!findBarHost();
        const endedBySubmit =
          gameOver &&
          lastSubmitAt > clockStart &&
          lastSubmitAt <= emptySince &&
          emptySince - lastSubmitAt < 20000;
        clockFrozen = endedBySubmit ? lastSubmitAt : Math.max(clockStart, emptySince);
        if (puzzleEntry && gameOver) puzzleEntry.completed = clockFrozen;
        saveTime();
        markGuesses(); // final reveal shows all solved rows
      }
    }
    if (clockStart) {
      const txt = fmtClock(baseMs + (clockFrozen || Date.now()) - clockStart);
      if (ui.clock.style.display !== 'none' && ui.clock.textContent !== txt) {
        ui.clock.textContent = txt;
      }
      // Live-update the current row in the history sidebar.
      const hm =
        histPanel && histPanel.querySelector('[data-cw-hist-current]');
      if (hm && hm.textContent !== txt) hm.textContent = txt;
      if (!clockFrozen && ++saveTick % 10 === 0) saveTime();
    } else if (!cards.length) {
      // Opened an already-finished puzzle (no tiles, so the clock never
      // started): show its recorded time instead of 0:00. Looked up once
      // per puzzle date, not every tick.
      const d = puzzleDate();
      if (finishedFor !== d) {
        finishedFor = d;
        const e = readTimes().find((x) => x.d === d && x.completed);
        finishedText = e ? fmtClock(e.ms) : '';
      }
      if (finishedText && ui.clock.textContent !== finishedText)
        ui.clock.textContent = finishedText;
    }
  }
  let finishedFor = null; // puzzle date whose finished time is shown
  let finishedText = '';

  // --- Dark mode ---
  // NYT ships a full dark palette for its games; the site just never turns it
  // on. It's keyed on <body data-mode="dark" class="display-settings-enabled">
  // and persisted in localStorage['nytd:mode'] ('dark' | 'light' | 'auto').
  // We flip that native switch, and if the page still computes light (i.e.
  // the dark CSS isn't loaded on this page) our own fallback rules kick in.

  const MODE_KEY = 'nytd:mode';
  const storedMode = () => {
    try {
      const v = JSON.parse(localStorage.getItem(MODE_KEY));
      return ['dark', 'light', 'auto'].includes(v) ? v : 'auto';
    } catch (_) {
      return 'auto';
    }
  };

  const darkOn = () => document.documentElement.hasAttribute('data-cw-dark');

  function setDark(on) {
    const b = document.body;
    b.dataset.mode = on ? 'dark' : 'light';
    b.classList.add('display-settings-enabled');
    try {
      localStorage.setItem(MODE_KEY, JSON.stringify(on ? 'dark' : 'light'));
    } catch (_) {}
    if (on) document.documentElement.setAttribute('data-cw-dark', '');
    else document.documentElement.removeAttribute('data-cw-dark');
    syncToggle();
    dlog('dark', on);
    // The page re-renders asynchronously; check the fallback twice.
    requestAnimationFrame(checkDarkFallback);
    setTimeout(checkDarkFallback, 250);
    setTimeout(syncTileColors, 300);
  }

  function applyDarkPref() {
    const mode = storedMode();
    const systemDark = !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    setDark(mode === 'dark' || (mode === 'auto' && systemDark));
    if (mode === 'auto') {
      try {
        localStorage.setItem(MODE_KEY, JSON.stringify('auto'));
      } catch (_) {}
    }
  }

  function syncToggle() {
    if (ui) ui.toggle.textContent = darkOn() ? '☀ Light' : '☾ Dark';
  }

  // If body and tiles still compute light backgrounds after enabling dark,
  // NYT's dark CSS isn't present on this page — use our fallback overrides.
  function checkDarkFallback() {
    if (!darkOn()) {
      document.documentElement.removeAttribute('data-cw-dark-fallback');
      return;
    }
    const cards = getCards();
    const bodyL = luminanceOf(getComputedStyle(document.body).backgroundColor);
    const tileL = cards.length
      ? luminanceOf(getComputedStyle(cards[0]).backgroundColor)
      : null;
    const stillLight =
      (bodyL === null || bodyL > 0.5) && (tileL === null || tileL > 0.6);
    if (stillLight)
      document.documentElement.setAttribute('data-cw-dark-fallback', '');
    else document.documentElement.removeAttribute('data-cw-dark-fallback');
    if (stillLight) dlog('dark fallback engaged');
  }

  // React can re-render the body attrs away; re-assert while dark is on.
  new MutationObserver(() => {
    if (darkOn() && document.body.dataset.mode !== 'dark') {
      document.body.dataset.mode = 'dark';
      document.body.classList.add('display-settings-enabled');
    }
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-mode', 'class'],
  });

  // --- Tile snapshots for the history panel ---
  // A frozen copy of the tile as rendered: the same element structure with
  // its computed layout/typography inlined, so it looks identical anywhere
  // (NYT's class names are hashed and its styles depend on ancestors).
  // Colors are left out on purpose: the tile is captured mid-selection
  // (dark), and the panel paints it in the category color or the current
  // theme's neutral tile color instead.
  const SNAP_ROOT = [
    'box-sizing', 'width', 'height', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'border-top-left-radius',
    'border-top-right-radius', 'border-bottom-left-radius',
    'border-bottom-right-radius', 'overflow',
  ];
  const SNAP_INHERITED = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'word-spacing', 'text-transform', 'text-align',
    'white-space', 'word-break', 'overflow-wrap', 'font-variant-ligatures',
  ];
  // Non-inherited properties, kept only when they differ from the default.
  const SNAP_OWN = {
    display: null, // always kept
    position: 'static',
    top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
    'flex-direction': 'row', 'flex-wrap': 'nowrap',
    'align-items': 'normal', 'justify-content': 'normal',
    'align-content': 'normal', gap: 'normal', 'row-gap': 'normal',
    'column-gap': 'normal', 'flex-grow': '0', 'flex-shrink': '1',
    'flex-basis': 'auto', 'margin-top': '0px', 'margin-right': '0px',
    'margin-bottom': '0px', 'margin-left': '0px', 'padding-top': '0px',
    'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'vertical-align': 'baseline', 'object-fit': 'fill', transform: 'none',
    opacity: '1', 'max-width': 'none', 'max-height': 'none',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function snapshotTile(card) {
    const rect = card.getBoundingClientRect();
    const css = (el, parentCs, isRoot) => {
      const cs = getComputedStyle(el);
      const out = [];
      const add = (p, v) => out.push(`${p}:${v}`);
      if (isRoot) {
        SNAP_ROOT.forEach((p) => add(p, cs.getPropertyValue(p)));
        // Use the laid-out size: computed width can lag a flip animation.
        out[1] = `width:${rect.width}px`;
        out[2] = `height:${rect.height}px`;
        add('position', 'relative');
      }
      SNAP_INHERITED.forEach((p) => {
        const v = cs.getPropertyValue(p);
        if (isRoot || !parentCs || parentCs.getPropertyValue(p) !== v) add(p, v);
      });
      for (const [p, def] of Object.entries(SNAP_OWN)) {
        if (isRoot && (p.startsWith('padding') || p === 'position')) continue;
        if (isRoot && p === 'transform') continue; // selection/flip animation
        const v = cs.getPropertyValue(p);
        if (def === null || v !== def) add(p, v);
      }
      // Replaced content keeps its exact box.
      if (!isRoot && /^(IMG|SVG|CANVAS|VIDEO|svg)$/.test(el.tagName)) {
        add('width', cs.width);
        add('height', cs.height);
      }
      return out.join(';');
    };

    const copy = (el, parentCs, isRoot) => {
      if (el.nodeType === 3) return document.createTextNode(el.nodeValue);
      if (el.nodeType !== 1) return null;
      const tag = el.tagName;
      if (/^(INPUT|SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|TEMPLATE)$/i.test(tag)) return null;
      const cs = getComputedStyle(el);
      // NYT keeps an invisible duplicate of the word for measuring.
      if (!isRoot && (cs.visibility === 'hidden' || cs.display === 'none')) return null;
      const isSvg = el.namespaceURI === SVG_NS;
      const out = isSvg
        ? document.createElementNS(SVG_NS, el.localName)
        : document.createElement(isRoot ? 'div' : el.localName);
      if (isSvg) {
        // SVG draws from its attributes; keep them, minus scripting/ids.
        for (const a of el.attributes) {
          if (/^(on|class$|id$|data-)/i.test(a.name)) continue;
          out.setAttribute(a.name, a.value);
        }
        if (el.localName !== 'svg') {
          [...el.childNodes].forEach((k) => {
            const c = copy(k, cs, false);
            if (c) out.appendChild(c);
          });
          return out;
        }
      } else if (tag === 'IMG') {
        ['src', 'srcset', 'alt', 'width', 'height'].forEach((a) => {
          if (el.hasAttribute(a)) out.setAttribute(a, el.getAttribute(a));
        });
        if (el.currentSrc) out.setAttribute('src', el.currentSrc);
      }
      out.setAttribute('style', css(el, parentCs, isRoot));
      [...el.childNodes].forEach((k) => {
        const c = copy(k, cs, false);
        if (c) out.appendChild(c);
      });
      return out;
    };

    const root = copy(card, getComputedStyle(card.parentElement || card), true);
    root.setAttribute('data-cw-tile', '');
    return { html: root.outerHTML, w: Math.round(rect.width * 100) / 100 };
  }

  // After a Submit, NYT shows a toast: "One away..." (3 of 4 right) or
  // "Already guessed!" (not counted). Watch for a new one briefly.
  const TOAST_SEL = '[data-testid="connection-toast"]';
  function watchToast(entry, guess) {
    const before = new Set(document.querySelectorAll(TOAST_SEL));
    const t0 = Date.now();
    const check = () => {
      const fresh = [...document.querySelectorAll(TOAST_SEL)].find(
        (el) => !before.has(el) && el.textContent.trim()
      );
      if (fresh) {
        const text = fresh.textContent.trim();
        if (/one away/i.test(text)) {
          guess[0].oneAway = true;
        } else if (/already guessed/i.test(text) && entry.guesses) {
          const i = entry.guesses.indexOf(guess);
          if (i >= 0) entry.guesses.splice(i, 1);
        } else return false;
        dlog('toast:', text);
        writeTimes(entry);
        if (histPanel) renderHistory();
        return true;
      }
      return Date.now() - t0 > 3000;
    };
    const iv = setInterval(() => check() && clearInterval(iv), 100);
  }

  // A guess was one away if NYT said so, or — once every tile's category is
  // known — exactly three of its four tiles share a category.
  function isOneAway(guess) {
    const items = guess.filter((x) => x && typeof x === 'object');
    if (items.some((x) => x.oneAway)) return true;
    if (items.length !== 4) return false;
    const cols = items.map((x) => x.correct);
    if (cols.some((c) => !c || c === 'solved')) return false;
    const counts = {};
    cols.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    return Object.values(counts).sort().join() === '1,3';
  }

  // Scale each stored tile to its history cell (cells are hidden until the
  // row is expanded, so size them when they actually get a width).
  let cellWidth = 0; // last measured history cell width, for re-renders
  const tileFit = new ResizeObserver((entries) => {
    for (const en of entries) {
      const cell = en.target;
      const tile = cell.firstElementChild;
      const w = +cell.dataset.w;
      if (!tile || !w || !cell.clientWidth) continue;
      cellWidth = cell.clientWidth;
      tile.style.zoom = String(cell.clientWidth / w);
    }
  });

  // Clicking the game's own Shuffle button resets to the game's order.
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest && e.target.closest('button');
      if (!btn) return;
      const label = [
        btn.textContent,
        btn.getAttribute('aria-label') || '',
        btn.getAttribute('data-testid') || '',
      ].join(' ');
      if (/shuffle/i.test(label)) {
        order = null;
        history = [];
        clearOrderStyles();
        dlog('shuffle: order reset');
        // The game re-renders the new order asynchronously; persist after.
        setTimeout(persistBoard, 50);
      } else if (/submit/i.test(label)) {
        lastSubmitAt = Date.now();
        // Record the guess: the 4 selected tiles, into this puzzle's
        // history entry. Each item is {t, h} — display text plus a mini
        // HTML snapshot so image/emoji tiles render as the real tile.
        const picked = getCards()
          .filter(isSelected)
          .map((c) => {
            const snap = snapshotTile(c);
            return { t: textOf(c), s: snap.html, w: snap.w };
          })
          .filter((x) => x.t);
        if (picked.length && puzzleEntry) {
          picked.forEach((x) => (x.s = compactSnap(x.s, puzzleEntry)));
          (puzzleEntry.guesses = puzzleEntry.guesses || []).push(picked);
          writeTimes();
          dlog('guess:', picked.map((x) => x.t).join(' '));
          watchToast(puzzleEntry, picked);
          if (histPanel) renderHistory();
          // The group flip/reveal animates in over ~1-2s; re-check a couple
          // times so a correct guess picks up its category color.
          setTimeout(markGuesses, 900);
          setTimeout(markGuesses, 2200);
        }
      }
    },
    true
  );

  window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  window.addEventListener('resize', schedulePosition, { passive: true });
  window.addEventListener('pagehide', saveTime);
  setInterval(tickClock, 500);

  // @dev-only:start — build.py removes this block from the .xpi, so the
  // bridge only exists when the harness loads the source folder.
  // Test bridge for dev/wf.mjs: history lives in extension storage, which
  // page scripts can't read. Only when localStorage['cw-test-bridge'] is
  // '1' can the page request it over postMessage. Off by default.
  try {
    if (localStorage.getItem('cw-test-bridge') === '1') {
      window.addEventListener('message', async (ev) => {
        const m = ev.data;
        if (ev.source !== window || !m || typeof m.cwReq !== 'string') return;
        await storeReadyP;
        let out = null;
        try {
          if (m.cwReq === 'records') out = readTimes();
          else if (m.cwReq === 'put') {
            window.__cw.putRecords(m.records || []);
            out = readTimes().length;
          } else if (m.cwReq === 'clear') {
            clearRecords();
            out = 0;
          } else if (m.cwReq === 'state') {
            out = { puzzleEntry: puzzleEntry && puzzleEntry.id, ready: storeReady };
          }
        } catch (err) {
          out = { error: String(err) };
        }
        window.postMessage({ cwRes: m.cwReq, id: m.id, out: JSON.parse(JSON.stringify(out)) }, '*');
      });
    }
  } catch (_) {}
  // @dev-only:end

  // Re-apply whenever the board re-renders (selection, solved groups, etc.).
  // Only childList is observed and apply() only touches attributes/styles,
  // so this can't loop. rAF is the fast path, with a setTimeout backstop:
  // rAF never fires in hidden tabs.
  let scheduled = false;
  const runApply = () => {
    if (!scheduled) return;
    scheduled = false;
    apply();
  };
  // Mutations inside our own overlays (clock text, HUD, tag quadrants) are
  // ours, not the game's — don't re-apply for them.
  const ownOverlay = (n) => {
    const el = n && n.nodeType === 1 ? n : n && n.parentElement;
    return !!(
      el && el.closest && el.closest('[data-cw-bar],[data-cw-hud],[data-cw-quad]')
    );
  };
  new MutationObserver((muts) => {
    if (scheduled || muts.every((m) => ownOverlay(m.target))) return;
    scheduled = true;
    requestAnimationFrame(runApply);
    setTimeout(runApply, 100);
  }).observe(document.body, { childList: true, subtree: true });

  apply();
  if (DEBUG.on) showHud();

  try {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    window.__cw.version = api.runtime.getManifest().version;
    console.info(`[Connextras] v${window.__cw.version} loaded`);
  } catch (_) {}
})();
