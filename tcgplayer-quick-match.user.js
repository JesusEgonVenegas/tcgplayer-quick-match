// ==UserScript==
// @name         TCGplayer Quick Match
// @namespace    https://github.com/JesusEgonVenegas
// @version      1.2.0
// @description  Fast keyboard-driven catalog matching for the TCGplayer Seller Portal scan-identify page — One Piece & Pokémon, with a base-vs-reprint/parallel guard, an auto scan-vs-catalog verifier, dynamic phantom-row skipping, a repair mode that re-matches rows mislabeled as anniversary reprints, and a keyboard audit mode for the Matched-to-Catalog tab (synced zoom, one-key approve, learned re-match patterns).
// @author       JesusEgonVenegas
// @license      MIT
// @homepageURL  https://github.com/JesusEgonVenegas/tcgplayer-quick-match
// @supportURL   https://github.com/JesusEgonVenegas/tcgplayer-quick-match/issues
// @match        https://sellerportal.tcgplayer.com/scan-identify/*
// @icon         https://www.tcgplayer.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/JesusEgonVenegas/tcgplayer-quick-match/main/tcgplayer-quick-match.user.js
// @updateURL    https://raw.githubusercontent.com/JesusEgonVenegas/tcgplayer-quick-match/main/tcgplayer-quick-match.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  const CONFIG = { pollMs: 100, timeoutMs: 8000, maxRecents: 30 };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el ? (el.textContent || '').trim() : '');
  const buttonsIn = root => [...root.querySelectorAll('button')];
  const findBtn = (root, label) => buttonsIn(root).find(b => txt(b) === label);
  // set-code compare: strip spaces AND dashes so the number's prefix "EB03" matches the set
  // code "EB-03", while "OP13" still stays distinct from the reprint "OP13 ANN" ("OP13ANN").
  const normCode = s => (s || '').toUpperCase().replace(/[\s-]+/g, '');

  let pendingThumb = null, pendingQuery = '', pendingNum = '', pendingCard = '';
  let pendingName = '', pendingSet = '', pendingSetName = '';
  // skipMode: 'auto' = skip rows that already have a catalog match (phantoms) & target the first
  // truly-unmatched one; a number N = force the Nth visible row from top (0 = top). See targetFindMatch.
  let sessionCount = 0, lastSaved = null, skipMode = 'auto';
  // repair mode: walk rows the scanner already matched to the WRONG set and re-match them to the
  // base set. pendingFixScope is the row awaiting its Save Match, so we only retire it once saved.
  let fixMode = false, pendingFixScope = null;
  // rows retired this session. Keyed by ELEMENT, not card # — the same # legitimately repeats across
  // rows when you scanned several copies. Backstop only: once saved, a row's set text stops matching
  // BAD_SET_RE anyway; this just covers the gap before React repaints.
  const fixedRows = new WeakSet();
  // review (audit) mode — walk the Matched-to-Catalog rows one at a time, scan vs catalog enlarged.
  // reviewTarget is the row whose re-match is in flight; reviewWrong is the identity we're correcting
  // AWAY from, banked into the pattern store once the new match is saved.
  let reviewActive = false, reviewIdx = 0, reviewTarget = null, reviewWrong = null;

  function waitFor(fn, timeout = CONFIG.timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function tick() {
        let r = null; try { r = fn(); } catch (_) {}
        if (r) return resolve(r);
        if (Date.now() - start > timeout) return reject(new Error('timeout'));
        setTimeout(tick, CONFIG.pollMs);
      })();
    });
  }

  function setReactInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function triggerSearch(modal, input, value) {
    input.focus();
    setReactInput(input, value + ' ');
    await sleep(80);
    setReactInput(input, value);
    await sleep(80);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
    findBtn(modal, 'Search')?.click();
  }

  // climb from el to the nearest card and return its image URL. data-imageurl is
  // always present (lazy <img src> is often a placeholder). When cardOnly, accept
  // only real catalog art (product-images host) and skip the dashed empty-state icon.
  function imgUrlNear(el, cardOnly, maxUp = 10) {
    const ok = u => u && !u.startsWith('data:') && (!cardOnly || u.includes('product-images'));
    let n = el;
    for (let i = 0; i < maxUp && n; i++) {
      for (const d of n.querySelectorAll('[data-imageurl]')) {
        const u = d.getAttribute('data-imageurl');
        if (ok(u)) return u;
      }
      for (const img of n.querySelectorAll('img')) {
        if (ok(img.src)) return img.src;
      }
      n = n.parentElement;
    }
    return '';
  }

  // cached: the modal stays mounted but hidden when closed, so we keep the element and just
  // re-check visibility (getClientRects) — only re-scanning the whole DOM when the cache misses.
  let cachedModal = null;
  function getModal() {
    if (cachedModal && cachedModal.isConnected &&
        cachedModal.getClientRects().length && cachedModal.querySelector('input')) return cachedModal;
    cachedModal = null;
    let heading = null;
    for (const e of document.querySelectorAll('*')) {
      if (txt(e) === 'Find Catalog Match' && e.getClientRects().length) { heading = e; break; }
    }
    if (!heading) return null;
    let n = heading;
    for (let i = 0; i < 8 && n; i++) { if (n.querySelector('input')) { cachedModal = n; return n; } n = n.parentElement; }
    return null;
  }

  const getRowScan = btn => imgUrlNear(btn, false);

  // One Piece card #s look like OP13-060 / ST01-001 / EB03-021 / PRB01-001 / P-001, never
  // Pokémon's 10/159. The set prefix ALWAYS carries 2 digits before the dash — critical so we
  // don't mistake a SET code like "EB-03" (which sits in the details text BEFORE the real #)
  // for the card number. Promos are the one exception: a bare "P-001". OP_ONLY anchors the
  // whole search box; NUM_RE finds either style anywhere in a result's text.
  const OP_ONLY = /^((?:OP|ST|EB|PRB)\d{2}|P)-\d{2,4}$/i;
  const isNumber = s =>
    /\d+\s*\/\s*\d+/.test(s) || /^\d+$/.test(s.trim()) || OP_ONLY.test(s.trim());

  const NUM_RE = /\b(?:OP|ST|EB|PRB)\d{2}-\d{2,4}\b|\bP-\d{2,4}\b|\b\d{1,3}\/\d{1,3}\b/i;
  // a PAGE ROW the scanner mislabeled — the set repair mode hunts for. Narrow on purpose: it
  // decides which of your already-matched rows get rewritten, so it must not over-reach.
  const BAD_SET_RE = /3rd Anniversary Tournament/i;
  // a RESULT inside the modal that repair must never auto-pick. Belt (name) and suspenders (code):
  // the reprint carries a suffixed code (OP13 ANN) the exact-code check already rejects, but a
  // pre-release may share the base code (OP13) and is only tellable by its set NAME.
  const EXCLUDE_SET_RE = /anniversary|tournament|pre-?release/i;
  const DETAILS_SEL = '.find-catalog-match-details__search-results-list-item-details';
  // the details block of THIS result only — handles the button being inside details or in
  // a sibling column, and never bleeds into neighbouring results (stops at the multi-item list).
  function resultDetails(btn) {
    let details = btn.closest(DETAILS_SEL);
    if (!details) {
      let n = btn.parentElement;
      for (let i = 0; i < 8 && n; i++) {
        const ds = n.querySelectorAll(DETAILS_SEL);
        if (ds.length === 1) { details = ds[0]; break; }  // single result item — safe to read
        if (ds.length > 1) break;                         // reached the multi-result list — stop, never bleed
        n = n.parentElement;
      }
    }
    return details;
  }
  const cellNumber = btn => { const m = txt(resultDetails(btn)).match(NUM_RE); return m ? m[0] : ''; };
  // largest ancestor that still holds exactly this ONE result (so its card art belongs to it)
  function resultItemScope(details) {
    let scope = details, n = details && details.parentElement;
    for (let i = 0; i < 4 && n; i++) {
      if (n.querySelectorAll(DETAILS_SEL).length !== 1) break;  // would include a neighbour — stop
      scope = n; n = n.parentElement;
    }
    return scope;
  }
  // a result's set line, e.g. "Carrying On His Will(OP13)" or
  // "Carrying On His Will: 3rd Anniversary Tournament Cards(OP13 ANN)" — carries BOTH the set
  // name and, in parens, the set code. This is what tells base from reprint.
  const setLineIn = d => (d ? txt(d.querySelector('.color-surface-subdued')) : '');
  const setLineOf = btn => setLineIn(resultDetails(btn));
  const parenCode = t => {
    const m = t.match(/\(([^)]+)\)\s*$/) || t.match(/\(([^)]+)\)/);
    return m ? m[1] : '';
  };
  const setCodeOf = btn => parenCode(setLineOf(btn));

  // opts.pinBaseSet — ignore the tray's learned set, force the number's own prefix (repair mode).
  // opts.excludeSet  — regex; results whose set line matches are never candidates at all.
  // opts.setName     — require the result's set LINE to contain this text. Pokémon results carry no
  //                    paren set code, so a saved re-match pattern ("this art is really Jungle, not
  //                    Hidden Fates") can only pin its set by name. Falls back if nothing matches.
  async function quickMatch(findMatchBtn, query, setStatus, opts = {}) {
    setStatus('opening…');
    findMatchBtn.click();
    const modal = await waitFor(getModal);
    const input = await waitFor(() =>
      modal.querySelector('input[placeholder*="number" i], input[placeholder*="name" i], input'));
    // search the BARE number — appending a name can wreck TCGplayer's fuzzy ranking (e.g.
    // "119/189 Eevee" surfaces Furret first, but "119/189" alone puts Eevee first). Instead
    // use any learned name to pick the RIGHT result among the exact-number matches below.
    const want = (query.match(NUM_RE) || [])[0];
    const learnedNames = (want && query.trim() === want)
      ? [...new Set(recents.filter(r => r.num === want && r.name).map(r => r.name))]
      : [];
    const learnedName = learnedNames.length === 1 ? learnedNames[0] : '';
    // One Piece: the same card # lives in a base set + anniversary/alt reprints (same NAME),
    // so the SET CODE disambiguates. Default to the base set — its paren code equals the
    // number's prefix (OP13-060 -> OP13), never a suffixed reprint (OP13 ANN). A single
    // learned set for this # overrides the default.
    const setPrefix = (want && OP_ONLY.test(want)) ? want.split('-')[0].toUpperCase() : '';
    const learnedSets = (want && query.trim() === want)
      ? [...new Set(recents.filter(r => r.num === want && r.set).map(r => r.set))]
      : [];
    const learnedSet = learnedSets.length === 1 ? learnedSets[0] : '';
    // set-code preference is One Piece-only (gated on setPrefix); Pokémon keeps its name-based
    // disambiguation untouched, since its result rows don't carry a paren set code to filter on.
    // Repair pins the bare prefix: a prior pass may have taught the tray the very reprint we're undoing.
    const prefSet = setPrefix ? (opts.pinBaseSet ? setPrefix : (learnedSet || setPrefix)) : '';
    const wantSetName = (opts.setName || '').trim().toLowerCase();
    setStatus((opts.pinBaseSet ? 'repairing…' : 'searching…') +
      (wantSetName ? ' [' + opts.setName + ']' : '') +
      (learnedName ? ' →' + learnedName : prefSet ? ' [' + prefSet + ']' : ''));
    await triggerSearch(modal, input, query);

    if (isNumber(query)) {
      setStatus('selecting…');
      const nameOf = b => { const d = resultDetails(b); return d ? txt(d.querySelector('.font-weight-600')) : ''; };
      // repair: drop the printings we're correcting AWAY from before anything else sees them, so
      // they can't win a fallback or inflate the printings guard. Test the set line; only if that
      // element is missing do we fall back to the whole details text (a card NAME could false-positive).
      const badSet = b => !!opts.excludeSet &&
        opts.excludeSet.test(setLineOf(b) || txt(resultDetails(b)));
      const exact = () => buttonsIn(modal).filter(b => txt(b) === 'Select')
        .filter(b => !badSet(b))
        .filter(b => want ? cellNumber(b) === want : txt(resultDetails(b) || b).includes(query));
      // rarity + finish for a result: "OP13-060, Common, Normal, English" -> "Common, Normal".
      // Two results sharing a # but differing here are different PRINTINGS (base vs alt-art/manga/foil).
      const LANG = /^(English|Japanese|S-Chinese|T-Chinese|Chinese|Korean|German|French|Italian|Spanish|Portuguese)$/i;
      function printingOf(btn) {
        const t = txt(resultDetails(btn)), n = (t.match(NUM_RE) || [])[0];
        if (!n) return '';
        const parts = t.slice(t.indexOf(n) + n.length).split(',').map(s => s.trim()).filter(Boolean);
        return parts.filter(p => !LANG.test(p)).slice(0, 2).join(', ');
      }
      const sigOf = b => [nameOf(b), normCode(setCodeOf(b)), printingOf(b)].join(' ¦ ');
      // narrow the exact-# matches by preferred set, then learned name. strict=true holds out
      // (empty) until a filter's target is present, so waitFor keeps polling; lenient falls back.
      function narrow(strict) {
        let c = exact();
        if (!c.length) return c;
        if (prefSet) { const s = c.filter(b => normCode(setCodeOf(b)) === normCode(prefSet)); if (s.length) c = s; else if (strict) return []; }
        if (wantSetName) { const s = c.filter(b => setLineOf(b).toLowerCase().includes(wantSetName)); if (s.length) c = s; else if (strict) return []; }
        if (learnedName) { const nm = c.filter(b => nameOf(b).toLowerCase() === learnedName.toLowerCase()); if (nm.length) c = nm; else if (strict) return []; }
        return c;
      }
      const pick = () => { const c = narrow(true); return c.length ? c[0] : null; };
      // wait for the preferred result; if it never resolves (stale set/name), fall back to first exact match
      const preferred = learnedName || prefSet || wantSetName;
      let select = null;
      try { select = await waitFor(pick, preferred ? 4500 : CONFIG.timeoutMs); } catch (_) {}
      if (!select) select = exact()[0] || null;
      if (!select) throw new Error('no exact match for ' + (want || query));
      // let the chosen result's art populate — re-find fresh each tick to dodge re-render staleness
      try {
        await waitFor(() => { const b = pick() || exact()[0]; const d = b && resultDetails(b); return d && cardFromCell(resultItemScope(d)); }, 2500);
      } catch (_) {}
      // GUARD: the same # exists as >1 distinct printing (Common vs Alternate Art / Manga / foil…).
      // Value differs and the SCAN — not the catalog — decides which you physically have, so refuse
      // to auto-save: scroll the choices in and let the eye + hover-preview pick. Save is manual then.
      const prints = new Map();
      for (const b of narrow(false)) { const s = sigOf(b); if (!prints.has(s)) prints.set(s, b); }
      if (prints.size > 1) {
        [...prints.values()][0].scrollIntoView({ block: 'center' });
        const opts = [...prints.keys()].map(s => s.split(' ¦ ').pop() || '?');
        setStatus('⚠ ' + prints.size + ' printings — pick: ' + opts.join('  /  '), 'warn');
        return;
      }
      select = pick() || exact()[0];
      if (!select) throw new Error('result vanished mid-search');
      select.click();
      const save = await waitFor(() => {
        const b = findBtn(modal, 'Save Match'); return b && !b.disabled ? b : null;
      });
      save.scrollIntoView({ block: 'center' });
      // always echo the single printing we auto-picked — your per-card proof the guard ran
      setStatus('verify & Save — ' + (printingOf(select) || '1 printing'), 'ok');
      // pop the enlarged scan-vs-catalog + the picked card's details, then Enter to save
      showVerify(pendingThumb, cardFromCell(resultItemScope(resultDetails(select))) || pendingCard, selectionDetail(select));
    } else {
      setStatus('pick a match ↑');
    }
  }

  // ---- recents persistence ----
  const keyOf = r => (r.num || r.query || '') + '|' + (r.set || '');
  function normalize(r) {
    return r.num ? r : {
      scan: r.scan || r.thumb || '', catalog: r.catalog || '',
      num: r.query || '', name: r.name || '', set: r.set || '', setName: r.setName || ''
    };
  }
  const loadRecents = () => {
    try { return (JSON.parse(localStorage.getItem('qm-recents')) || []).map(normalize); }
    catch (_) { return []; }
  };
  const saveRecents = r => localStorage.setItem('qm-recents', JSON.stringify(r));
  let recents = loadRecents();

  function addRecent(entry) {
    if (!entry.num) return;
    recents = recents.filter(r => keyOf(r) !== keyOf(entry));
    recents.unshift(entry);
    recents = recents.slice(0, CONFIG.maxRecents);
    saveRecents(recents);
    renderRecents(qInput.value.trim());
  }

  // ---- floating panel ----
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:8px;padding:8px 10px;font:13px sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:440px';
  panel.innerHTML =
    '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      '<input id="qm-q" placeholder="card #, or name to filter tray" style="width:160px;padding:4px;background:#000;color:#fff;border:1px solid #555;border-radius:4px">' +
      '<span id="qm-status" style="opacity:.7;min-width:80px">ready</span>' +
      '<span id="qm-count" title="matched this session" style="font-size:12px;color:#7ec27e">✓0</span>' +
      '<button id="qm-undo" title="remove last tray entry &amp; reload its number" style="cursor:pointer;background:#333;color:#aaa;border:1px solid #555;border-radius:4px;padding:2px 6px">⎌</button>' +
      '<button id="qm-skip" title="glitched phantom on top? target the 2nd unmatched row instead" style="cursor:pointer;border-radius:4px;padding:2px 6px">skip top</button>' +
      '<button id="qm-fix" style="cursor:pointer;border-radius:4px;padding:2px 6px">fix: off</button>' +
      '<button id="qm-review" title="audit the Matched to Catalog rows one by one (Alt+A)" style="cursor:pointer;background:#333;color:#aaa;border:1px solid #555;border-radius:4px;padding:2px 6px">review</button>' +
      '<button id="qm-clear" title="clear recents" style="cursor:pointer;background:#333;color:#aaa;border:1px solid #555;border-radius:4px;padding:2px 6px">clear</button>' +
    '</div>' +
    '<div id="qm-recents" style="display:flex;gap:6px;flex-wrap:nowrap;margin-top:8px;overflow-x:auto;overflow-y:hidden;padding-bottom:4px"></div>';
  document.body.appendChild(panel);
  const qInput = panel.querySelector('#qm-q');
  const recentsEl = panel.querySelector('#qm-recents');
  // kind: 'warn' (amber text + glowing panel border, stays until next status), 'ok' (green), else muted.
  const statusEl = panel.querySelector('#qm-status');
  const setStatus = (s, kind) => {
    statusEl.textContent = s;
    statusEl.style.color = kind === 'warn' ? '#ffcf3f' : kind === 'ok' ? '#7ec27e' : '';
    statusEl.style.opacity = kind ? '1' : '.7';
    statusEl.style.fontWeight = kind === 'warn' ? '700' : '';
    panel.style.borderColor = kind === 'warn' ? '#ffcf3f' : '#444';
    panel.style.boxShadow = kind === 'warn'
      ? '0 0 0 2px rgba(255,207,63,.45), 0 2px 10px rgba(0,0,0,.5)'
      : '0 2px 10px rgba(0,0,0,.5)';
  };
  const updateCounter = () => { panel.querySelector('#qm-count').textContent = '✓' + sessionCount; };
  const skipBtn = panel.querySelector('#qm-skip');
  const SKIP_CYCLE = ['auto', 0, 1, 2, 3, 4];   // left-click cycles; right-click steps back
  const renderSkip = () => {
    const on = skipMode !== 0;                  // 0 == "off" (force top row)
    skipBtn.textContent = skipMode === 'auto' ? 'skip: auto' : skipMode === 0 ? 'skip: off' : 'skip: ' + skipMode + ' ▲';
    skipBtn.style.background = on ? '#7a5a12' : '#333';
    skipBtn.style.color = on ? '#ffd77a' : '#aaa';
    skipBtn.style.border = '1px solid ' + (on ? '#c99a3a' : '#555');
  };
  const cycleSkip = dir => {
    const i = SKIP_CYCLE.indexOf(skipMode);
    skipMode = SKIP_CYCLE[(i + dir + SKIP_CYCLE.length) % SKIP_CYCLE.length];
    renderSkip();
    const list = findMatchBtns(), n = list.length;
    if (skipMode === 'auto') {
      const matched = list.filter(rowMatched).length;   // live proof it's spotting the phantoms
      setStatus('skip: auto — ' + matched + ' matched of ' + n + ' skipped', 'warn');
    } else {
      setStatus(skipMode === 0 ? 'skip: off — top row' : 'skip: ' + skipMode + ' — row ' + (skipMode + 1) + ' of ' + n,
        skipMode === 0 ? undefined : 'warn');
    }
  };
  skipBtn.onclick = () => cycleSkip(1);
  skipBtn.oncontextmenu = e => { e.preventDefault(); cycleSkip(-1); };   // right-click steps back
  skipBtn.title = 'phantom rows on top? left-click to cycle skip (auto/off/1-4), right-click to step back';
  renderSkip();

  // repair toggle. On, Enter stops matching unidentified rows and starts re-matching the mislabeled
  // ones instead — same two-keystroke rhythm (Enter to pick, glance, Enter to save).
  const fixBtn = panel.querySelector('#qm-fix');
  const renderFix = () => {
    const n = fixMode ? badRows().length : 0;
    fixBtn.textContent = fixMode ? 'fix: ' + n + ' bad' : 'fix: off';
    fixBtn.style.background = fixMode ? '#12507a' : '#333';
    fixBtn.style.color = fixMode ? '#9fd2ff' : '#aaa';
    fixBtn.style.border = '1px solid ' + (fixMode ? '#3a86c9' : '#555');
    fixBtn.title = 'repair rows mislabeled "' + BAD_SET_RE.source.replace(/\\/g, '') +
      '" — Enter re-matches the next one to its base set';
  };
  fixBtn.onclick = () => {
    fixMode = !fixMode;
    pendingFixScope = null;
    renderFix();
    if (!fixMode) { setStatus('fix: off'); return; }
    const n = badRows().length;
    setStatus(n ? 'fix: ' + n + ' mislabeled — Enter to start' : 'fix: none found on this page', n ? 'warn' : undefined);
  };
  renderFix();
  panel.querySelector('#qm-clear').onclick = () => { recents = []; saveRecents(recents); renderRecents(); };
  panel.querySelector('#qm-undo').onclick = () => {
    if (!lastSaved) { setStatus('nothing to undo'); return; }
    recents = recents.filter(r => keyOf(r) !== keyOf(lastSaved));
    saveRecents(recents);
    qInput.value = lastSaved.num || '';
    sessionCount = Math.max(0, sessionCount - 1);
    updateCounter();
    renderRecents(qInput.value.trim());
    setStatus('removed — # reloaded');
    lastSaved = null;
  };

  // ---- hover preview (scan + catalog, enlarged) ----
  const preview = document.createElement('div');
  preview.style.cssText = 'position:fixed;z-index:100000;background:#111;border:1px solid #555;border-radius:8px;padding:8px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.6)';
  document.body.appendChild(preview);
  function showPreview(anchor, scan, catalog, label) {
    const cell = (src, lab) => src
      ? '<div style="text-align:center"><img src="' + src + '" style="width:150px;border-radius:4px;display:block">' +
        '<div style="font-size:10px;opacity:.6;margin-top:2px">' + lab + '</div></div>'
      : '';
    preview.innerHTML =
      '<div style="display:flex;gap:8px">' + cell(scan, 'scan') + cell(catalog, 'match') + '</div>' +
      '<div style="text-align:center;font-size:11px;margin-top:4px;color:#eee">' + label + '</div>';
    preview.style.display = 'block';
    const rect = anchor.getBoundingClientRect();
    preview.style.left = Math.max(8, rect.left) + 'px';
    preview.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  }
  const hidePreview = () => { preview.style.display = 'none'; };
  recentsEl.addEventListener('mouseleave', hidePreview);   // belt-and-suspenders if a chip's own leave is missed

  // ---- auto side-by-side verify: your scan vs the catalog art, enlarged in the empty page area
  // to the LEFT of the match modal, so on a pick you just glance and hit Enter (no hovering). ----
  const verifyEl = document.createElement('div');
  verifyEl.style.cssText = 'position:fixed;z-index:100000;display:none;pointer-events:none';   // never blocks clicks
  document.body.appendChild(verifyEl);
  const hideVerify = () => { verifyEl.style.display = 'none'; };
  const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function showVerify(scan, catalog, detail) {
    if (!scan && !catalog) { hideVerify(); return; }
    const H = Math.round(Math.min(440, window.innerHeight * 0.56)), W = Math.round(H * 0.716);
    const cell = (src, lab, extra) => src
      ? '<div style="width:' + W + 'px;text-align:center">' +
          '<img src="' + src + '" style="width:' + W + 'px;height:' + H + 'px;object-fit:contain;border-radius:10px;background:#0c0c0c;box-shadow:0 6px 24px rgba(0,0,0,.7)">' +
          '<div style="font-size:13px;color:#cfe;margin-top:6px">' + lab + '</div>' + (extra || '') + '</div>'
      : '<div style="width:' + W + 'px;height:' + H + 'px;display:flex;align-items:center;justify-content:center;color:#777;border:1px dashed #555;border-radius:10px">no image</div>';
    // details under the catalog card — set line highlighted, since OP11 vs OP11 RE (event) is the tell
    const detHtml = detail
      ? '<div style="margin-top:8px;text-align:left;font-size:12.5px;line-height:1.4;background:#0c0c0c;border-radius:8px;padding:8px 10px">' +
          '<div style="color:#fff;font-weight:600">' + esc(detail.name) + '</div>' +
          '<div style="color:#ffcf5a;font-weight:600">' + esc(detail.setLine) + '</div>' +
          '<div style="color:#bcbcbc">' + esc(detail.num) + (detail.tail ? ' · ' + esc(detail.tail) : '') + '</div>' +
        '</div>'
      : '';
    verifyEl.innerHTML =
      '<div style="position:relative;display:flex;gap:18px;align-items:flex-start;background:rgba(0,0,0,.6);padding:16px;border-radius:14px">' +
        cell(scan, 'your scan') + cell(catalog, 'catalog match', detHtml) +
        // pointer-events:auto ONLY on the × so the rest of the overlay still never blocks Save/Cancel
        '<div id="qm-vclose" title="close (Esc)" style="position:absolute;top:8px;right:8px;width:26px;height:26px;line-height:24px;text-align:center;background:#333;color:#eee;border:1px solid #666;border-radius:50%;font-size:16px;cursor:pointer;pointer-events:auto">×</div>' +
      '</div>' +
      '<div style="text-align:center;color:#8fd88f;font-size:14px;margin-top:10px;font-weight:600">✓ both match?&nbsp; Enter to save · Esc / × to close</div>';
    const closeBtn = verifyEl.querySelector('#qm-vclose');
    if (closeBtn) closeBtn.onclick = hideVerify;
    verifyEl.style.display = 'block';
    verifyEl.style.left = '0px'; verifyEl.style.top = '0px';        // reset before measuring
    const modal = getModal();                                       // center in the space left of the modal
    const rightEdge = modal ? modal.getBoundingClientRect().left : window.innerWidth;
    verifyEl.style.left = Math.max(8, (rightEdge - verifyEl.offsetWidth) / 2) + 'px';
    verifyEl.style.top  = Math.max(8, (window.innerHeight - verifyEl.offsetHeight) / 2) + 'px';
  }

  function renderRecents(filter = '') {
    hidePreview();              // a re-render can orphan a hovered chip, stranding the preview
    recentsEl.innerHTML = '';
    const f = filter.toLowerCase();
    for (const r of recents) {
      const num = r.num || '', name = r.name || '', set = r.set || '';
      if (f && !(num.toLowerCase().includes(f) || name.toLowerCase().includes(f) || set.toLowerCase().includes(f))) continue;
      const scan = r.scan || '', catalog = r.catalog || '';
      const wrap = document.createElement('div');
      wrap.title = [name, num, set].filter(Boolean).join('  ·  ') + '  (click to reuse)';
      wrap.style.cssText = 'position:relative;cursor:pointer;text-align:center;width:46px;flex:0 0 auto';
      const img = document.createElement('img');
      img.src = catalog || scan;
      img.style.cssText = 'width:42px;height:58px;object-fit:cover;border:1px solid #555;border-radius:3px';
      const cap = document.createElement('div');
      cap.textContent = num;
      cap.style.cssText = 'font-size:9px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const setCap = document.createElement('div');
      setCap.textContent = set;
      setCap.style.cssText = 'font-size:8px;opacity:.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const del = document.createElement('div');
      del.textContent = '×';
      del.title = 'delete this entry';
      del.style.cssText = 'position:absolute;top:0;right:0;width:15px;height:15px;line-height:14px;text-align:center;background:#b33;color:#fff;border-radius:50%;font-size:12px;cursor:pointer;display:none';
      const label = [num, set, name].filter(Boolean).join(' · ');
      const removeSelf = () => { recents = recents.filter(x => keyOf(x) !== keyOf(r)); saveRecents(recents); };
      del.onclick = ev => { ev.stopPropagation(); removeSelf(); renderRecents(qInput.value.trim()); setStatus('deleted ✕'); };
      wrap.append(img, cap, setCap, del);
      wrap.onclick = () => { qInput.value = num; qInput.focus(); renderRecents(num); setStatus('loaded ↓'); };
      wrap.onmouseenter = () => { showPreview(wrap, scan, catalog, label); del.style.display = 'block'; };
      wrap.onmouseleave = () => { hidePreview(); del.style.display = 'none'; };
      recentsEl.appendChild(wrap);
    }
  }

  // ---- big centered "match dialog": scan-to-match on the left, whole tray as a large
  // scrollable gallery on the right. Arrow to the match, Enter = load its # + fire the Find. ----
  // which unmatched row we act on: normally the top one, but skip it when a phantom haunts position 1.
  // filter to VISIBLE buttons and sort by on-screen vertical position — DOM order can't be trusted
  // (a glitch row may be a hidden/duplicate node or sit out of document order).
  // 'Find Match' sits on rows with NO catalog match; 'Find New Match' on rows already matched
  // (right or wrong). Repair mode drives the latter.
  const FIND_MATCH = 'Find Match', FIND_NEW = 'Find New Match';
  const visibleBtns = label => [...document.querySelectorAll('button')]
    .filter(b => txt(b) === label && b.getClientRects().length)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const findMatchBtns = () => visibleBtns(FIND_MATCH);
  const isDisabled = b => !!b && (b.disabled === true || b.getAttribute('aria-disabled') === 'true' ||
    getComputedStyle(b).cursor === 'not-allowed');
  // the Delete / Confirm Match / Find Match trio share a small container — find THIS row's Confirm Match
  function confirmMatchFor(findBtn) {
    let n = findBtn.parentElement;
    for (let i = 0; i < 6 && n; i++) {
      const cms = [...n.querySelectorAll('button')].filter(b => txt(b) === 'Confirm Match');
      if (cms.length === 1) return cms[0];   // this row's group
      if (cms.length > 1) break;             // climbed into multi-row territory
      n = n.parentElement;
    }
    return null;
  }
  // a row already HAS a catalog match (phantom / auto-match) if its Confirm Match button is ENABLED.
  // fallback: the row's detail text doesn't say "unavailable". Unknown -> unmatched (never wrongly skip).
  function rowMatched(findBtn) {
    const cm = confirmMatchFor(findBtn);
    if (cm) return !isDisabled(cm);
    let n = findBtn;
    for (let i = 0; i < 14 && n; i++) {
      if (/Card #:/i.test(txt(n)) && [...n.querySelectorAll('button')].filter(b => txt(b) === 'Find Match').length === 1)
        return !/unavailable/i.test(txt(n));
      n = n.parentElement;
    }
    return false;
  }
  const targetFindMatch = () => {
    const list = findMatchBtns();
    if (!list.length) return null;
    if (skipMode === 'auto') {                       // skip already-matched phantom rows dynamically
      const unmatched = list.filter(b => !rowMatched(b));
      console.debug('[QuickMatch] auto-skip:', list.length, 'rows,', list.length - unmatched.length, 'matched/phantom skipped');
      return unmatched[0] || list[0];                // all matched? fall back to the top
    }
    return list[Math.min(skipMode, list.length - 1)];  // manual: Nth from top
  };

  // ---- repair mode: rows the scanner matched to the wrong set ----
  // The largest ancestor of a row's button that still holds exactly ONE such button — i.e. this row
  // alone. Climbing past that swallows a neighbour, and we'd read ITS set line and card number.
  function rowScopeOf(btn, label) {
    let scope = btn, n = btn.parentElement;
    for (let i = 0; i < 12 && n; i++) {
      if ([...n.querySelectorAll('button')].filter(b => txt(b) === label).length !== 1) break;
      scope = n; n = n.parentElement;
    }
    return scope;
  }
  // "(OP13 ANN)" can't match NUM_RE (it demands -NNN), so the row's own card # is the only hit.
  const rowNumberOf = scope => (txt(scope).match(NUM_RE) || [])[0] || '';
  const rowIsBad = scope => BAD_SET_RE.test(txt(scope));
  function badRows() {
    const out = [];
    for (const btn of visibleBtns(FIND_NEW)) {
      const scope = rowScopeOf(btn, FIND_NEW);
      if (fixedRows.has(scope) || !rowIsBad(scope)) continue;
      const num = rowNumberOf(scope);
      if (num) out.push({ btn, scope, num });   // no readable # -> never guess, leave it for the eye
    }
    return out;
  }
  const PCOLS = 5;                       // gallery columns; up/down move by this many
  let pickerEl = null, pGrid = null, pCountEl = null, pList = [], pIdx = 0;

  function paintSelection() {
    if (!pGrid) return;
    [...pGrid.children].forEach((t, i) => {
      t.style.borderColor = i === pIdx ? '#4da3ff' : 'transparent';
      t.style.background = i === pIdx ? '#1d3a55' : '#181818';
    });
    const cur = pGrid.children[pIdx];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    if (pCountEl) pCountEl.textContent = pList.length ? (pIdx + 1) + '/' + pList.length : '0';
  }
  function renderGrid(filter = '') {
    const f = filter.toLowerCase();
    pList = recents.filter(r => !f ||
      (r.num || '').toLowerCase().includes(f) ||
      (r.name || '').toLowerCase().includes(f) ||
      (r.set || '').toLowerCase().includes(f));
    pIdx = Math.max(0, Math.min(pIdx, pList.length - 1));
    pGrid.innerHTML = '';
    pList.forEach((r, i) => {
      const tile = document.createElement('div');
      tile.style.cssText = 'cursor:pointer;border:2px solid transparent;border-radius:8px;padding:5px;text-align:center;background:#181818';
      const im = document.createElement('img');
      im.src = r.catalog || r.scan || '';
      im.style.cssText = 'width:100%;aspect-ratio:5/7;object-fit:cover;border-radius:5px;display:block';
      const c1 = document.createElement('div');
      c1.textContent = r.num || '';
      c1.style.cssText = 'font-size:12px;color:#e6e6e6;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const c2 = document.createElement('div');
      c2.textContent = [r.set, r.name].filter(Boolean).join(' · ');
      c2.style.cssText = 'font-size:10px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      tile.append(im, c1, c2);
      tile.onmouseenter = () => { pIdx = i; paintSelection(); };
      tile.onclick = () => { pIdx = i; pickCurrent(); };
      pGrid.appendChild(tile);
    });
    paintSelection();
  }
  function gridMove(delta) {
    if (!pList.length) return;
    pIdx = Math.max(0, Math.min(pIdx + delta, pList.length - 1));
    paintSelection();
  }
  function pickCurrent() {
    const r = pList[pIdx];
    closePicker();
    if (!r) return;
    qInput.value = r.num || '';
    renderRecents(r.num || '');
    runEnter();                          // load the # + open Find Match + auto-select, in one shot
  }
  function closePicker() {
    if (pickerEl) { pickerEl.remove(); pickerEl = null; pGrid = null; pCountEl = null; }
    qInput.focus();
  }
  function openPicker() {
    if (pickerEl) return;
    hideVerify();
    if (!recents.length) { setStatus('tray empty'); return; }
    const fm = targetFindMatch();
    const scan = fm ? getRowScan(fm) : '';
    pIdx = 0;

    pickerEl = document.createElement('div');
    pickerEl.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:24px;font:13px sans-serif';
    pickerEl.onclick = e => { if (e.target === pickerEl) closePicker(); };   // backdrop click closes

    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:16px;width:min(1100px,95vw);height:min(82vh,780px);background:#111;color:#eee;border:1px solid #444;border-radius:12px;padding:16px;box-shadow:0 8px 40px rgba(0,0,0,.7)';

    const left = document.createElement('div');
    left.style.cssText = 'flex:0 0 40%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border-right:1px solid #333;padding-right:16px;min-width:0';
    left.innerHTML = scan
      ? '<div style="font-size:12px;color:#9ab">card to match (top unmatched row)</div>' +
        '<img src="' + scan + '" style="max-width:100%;max-height:calc(82vh - 120px);border-radius:8px;object-fit:contain">'
      : '<div style="color:#888;text-align:center">No unmatched row detected on the page.<br>Scroll to an Unidentified card, then reopen.</div>';

    const right = document.createElement('div');
    right.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0';
    const rHead = document.createElement('div');
    rHead.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:10px';
    const fInput = document.createElement('input');
    fInput.placeholder = 'type a # or filter · ← ↑ ↓ → move · Enter = pick / search · Esc close';
    fInput.style.cssText = 'flex:1;padding:7px 9px;background:#000;color:#fff;border:1px solid #555;border-radius:6px;font:13px sans-serif';
    pCountEl = document.createElement('span');
    pCountEl.style.cssText = 'font-size:12px;color:#888;min-width:44px;text-align:right';
    rHead.append(fInput, pCountEl);
    pGrid = document.createElement('div');
    pGrid.style.cssText = 'display:grid;grid-template-columns:repeat(' + PCOLS + ',1fr);gap:10px;overflow-y:auto;align-content:start;padding-right:4px';
    right.append(rHead, pGrid);

    box.append(left, right);
    pickerEl.append(box);
    document.body.appendChild(pickerEl);

    fInput.addEventListener('input', () => { pIdx = 0; renderGrid(fInput.value.trim()); });
    fInput.addEventListener('keydown', e => {
      const k = e.key;
      if (k === 'Escape')          { e.preventDefault(); closePicker(); }
      else if (k === 'Enter') {
        e.preventDefault();
        const typed = fInput.value.trim();
        // a tray match is highlighted -> pick it; otherwise run whatever you typed (a # not on the tray)
        if (pList.length) pickCurrent();
        else if (typed) { closePicker(); qInput.value = typed; renderRecents(typed); runEnter(); }
      }
      else if (k === 'ArrowRight') { e.preventDefault(); gridMove(1); }
      else if (k === 'ArrowLeft')  { e.preventDefault(); gridMove(-1); }
      else if (k === 'ArrowDown')  { e.preventDefault(); gridMove(PCOLS); }
      else if (k === 'ArrowUp')    { e.preventDefault(); gridMove(-PCOLS); }
      // any other key falls through to type into the filter
    });

    renderGrid('');
    fInput.focus();
  }

  // ================= review (audit) mode: Matched to Catalog =================
  // The scanner's match is usually *plausible* and sometimes wrong: same art, different set, different
  // card #. The only tell is reading the # off BOTH images. So: walk the matched rows one at a time,
  // both images blown up with a synced magnifier, the catalog's claimed #/set/variant/price beside
  // them. One key to approve, one key to re-match. Corrections are banked as PATTERNS — the scanner
  // repeats its mistakes, so the second time we see the same wrong match we prefill and auto-select
  // the correction for you.

  // ---- learned re-match patterns: wrong identity (what the scanner claimed) -> right one ----
  const FIXES_KEY = 'qm-fixes';
  const loadFixes = () => { try { return JSON.parse(localStorage.getItem(FIXES_KEY)) || {}; } catch (_) { return {}; } };
  let fixes = loadFixes();
  const saveFixes = () => localStorage.setItem(FIXES_KEY, JSON.stringify(fixes));
  // key on the WRONG match, not the scan: that's what repeats. Same bogus name+#+set -> same fix.
  const wrongKey = w => [w.name, w.num, w.set].map(s => (s || '').trim().toLowerCase()).join('|');
  const fixFor = row => (row && row.num ? fixes[wrongKey(row)] : null) || null;
  const setLabel = f => (f.setName || f.set || '');
  function recordFix(wrong, right) {
    if (!wrong || !wrong.num || !right.num) return;
    const sameNum = wrong.num.toLowerCase() === right.num.toLowerCase();
    const sameSet = (wrong.set || '').toLowerCase() === setLabel(right).toLowerCase();
    if (sameNum && sameSet) return;                       // re-picked the same card — nothing learned
    const k = wrongKey(wrong), prev = fixes[k];
    fixes[k] = { wrong, num: right.num, name: right.name, set: right.set, setName: right.setName,
                 scan: right.scan || '', catalog: right.catalog || '', count: (prev ? prev.count : 0) + 1 };
    saveFixes();
    renderReviewBtn();
  }

  // ---- read a matched row: images by caption, fields by label ----
  const CAPTION_RE = /^(Scan Image|Catalog Image)$/i;
  const imgIn = n => {
    const urls = [];
    for (const d of n.querySelectorAll('[data-imageurl]')) {
      const u = d.getAttribute('data-imageurl');
      if (u && !u.startsWith('data:')) urls.push(u);
    }
    if (!urls.length) for (const im of n.querySelectorAll('img')) {
      if (im.src && !im.src.startsWith('data:')) urls.push(im.src);
    }
    return urls;
  };
  // climb from the "Scan Image" / "Catalog Image" caption until exactly ONE image is in scope — one
  // more level up would swallow the neighbouring card and we'd show the wrong art.
  function imgByCaption(scope, caption) {
    for (const el of scope.querySelectorAll('*')) {
      if (!CAPTION_RE.test(txt(el)) || txt(el).toLowerCase() !== caption.toLowerCase()) continue;
      let n = el;
      for (let i = 0; i < 5 && n && n !== scope.parentElement; i++) {
        const urls = imgIn(n);
        if (urls.length === 1) return urls[0];
        if (urls.length > 1) break;               // climbed into both cards — give up, use the fallback
        n = n.parentElement;
      }
    }
    return '';
  }
  function rowArt(scope) {
    let scan = imgByCaption(scope, 'Scan Image');
    let catalog = imgByCaption(scope, 'Catalog Image');
    if (!scan || !catalog) {                      // captions missing (list view / re-render): host tells them apart
      const urls = imgIn(scope);
      if (!catalog) catalog = urls.find(u => u.includes('product-images')) || '';
      if (!scan) scan = urls.find(u => u !== catalog) || '';
    }
    return { scan, catalog };
  }
  // the SMALLEST element whose text starts with the label and carries a value ("Card #: 41/68").
  // Ancestors start with the card name, the label span alone has no value — both excluded.
  function fieldEl(scope, label) {
    let best = null, bestLen = Infinity;
    for (const el of scope.querySelectorAll('*')) {
      const t = txt(el);
      if (t.length <= label.length || !t.startsWith(label)) continue;
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    return best;
  }
  const fieldOf = (scope, label) => {
    const el = fieldEl(scope, label);
    return el ? txt(el).slice(label.length).trim() : '';
  };
  // the row's card name: the last real text before the "Card #:" field (the captions and the images
  // come first in DOM order, the labelled fields after).
  function rowNameOf(scope) {
    const numEl = fieldEl(scope, 'Card #:');
    let name = '';
    for (const el of scope.querySelectorAll('*')) {
      // stop once we're INSIDE the card-# field — not at its ancestors, which come first in document
      // order and would cut the walk short before it ever reaches the name.
      if (numEl && (el === numEl || numEl.contains(el))) break;
      if (el.children.length) continue;                       // leaves only
      const t = txt(el);
      if (!t || CAPTION_RE.test(t) || /:$/.test(t) || el.closest('button')) continue;
      name = t;
    }
    return name;
  }
  function priceOf(scope) {
    const all = txt(scope), i = all.indexOf('Listing Price');
    const t = i >= 0 ? all.slice(i) : all;
    const p = t.match(/\$\d[\d,]*\.\d{2}/);
    const mk = t.match(/TCG\s+(?:Market|Low|Mid)\s*[+\-−]?\s*\$?\d[\d,]*\.\d{2}/i);
    return { price: p ? p[0] : '', market: mk ? mk[0] : '' };
  }
  function parseRow(scope) {
    const { price, market } = priceOf(scope);
    return {
      ...rowArt(scope),
      name: rowNameOf(scope),
      num: fieldOf(scope, 'Card #:'),
      set: fieldOf(scope, 'Set:'),
      variant: fieldOf(scope, 'Variant:'),
      conf: fieldOf(scope, 'Match Confidence:'),
      seq: fieldOf(scope, 'Import sequence #:'),
      price, market
    };
  }
  // every matched row on the page, top to bottom. Re-read on every move — React re-renders rows
  // constantly, so a cached element list goes stale the moment a match is saved. Only the row we're
  // actually looking at gets scoped + parsed; walking 100 rows' subtrees per keypress is wasted work.
  const reviewBtns = () => visibleBtns(FIND_NEW);
  function reviewRow(i, list) {
    const btn = (list || reviewBtns())[i];
    if (!btn) return null;
    const scope = rowScopeOf(btn, FIND_NEW);
    return { btn, scope, ...parseRow(scope) };
  }
  // resume where you left off — a 500-card batch is many sittings. Keyed by batch (the URL path).
  const progKey = () => 'qm-review-at:' + location.pathname;
  const nextPageBtn = () => [...document.querySelectorAll('button,a')]
    .filter(e => e.getClientRects().length && !isDisabled(e))
    .find(e => /next/i.test(e.getAttribute('aria-label') || '') || /^(›|>|→|»)$/.test(txt(e))) || null;

  // ---- overlay ----
  let reviewEl = null, zPanes = [], zOn = false, zLevel = 2.8, zPx = 50, zPy = 50, fixInput = null;
  const reviewBtn = () => panel.querySelector('#qm-review');
  function renderReviewBtn() {
    const b = reviewBtn(); if (!b) return;
    const n = Object.keys(fixes).length;
    b.textContent = (reviewActive ? 'review ●' : 'review') + (n ? ' (' + n + ')' : '');
    b.style.background = reviewActive ? '#155e3f' : '#333';
    b.style.color = reviewActive ? '#9ff0c8' : '#aaa';
    b.style.border = '1px solid ' + (reviewActive ? '#2fa476' : '#555');
    b.title = 'audit the Matched to Catalog rows one by one (Alt+A)' +
      (n ? ' — ' + n + ' learned re-match pattern' + (n === 1 ? '' : 's') + ' (right-click to clear)' : '');
  }
  function paintZoom() {
    for (const im of zPanes) {
      im.style.transformOrigin = zPx + '% ' + zPy + '%';
      im.style.transform = 'scale(' + (zOn ? zLevel : 1) + ')';
    }
    const z = reviewEl && reviewEl.querySelector('#qm-rzoom');
    if (z) z.textContent = zOn ? zLevel.toFixed(1) + '×' : 'hover a card to magnify · wheel = zoom';
  }
  const hideReview = () => { if (reviewEl) reviewEl.style.display = 'none'; };
  function closeReview() {
    reviewActive = false; reviewTarget = null; reviewWrong = null;
    if (reviewEl) { reviewEl.remove(); reviewEl = null; }
    zPanes = []; fixInput = null;
    renderReviewBtn();
    setStatus('review closed');
    qInput.focus();
  }
  function openReview() {
    const n = reviewBtns().length;
    if (!n) { setStatus('no matched rows here — open the Matched to Catalog tab', 'warn'); return; }
    if (getModal()) { setStatus('close the match dialog first', 'warn'); return; }
    reviewActive = true;
    const saved = parseInt(localStorage.getItem(progKey()) || '0', 10);
    reviewIdx = Number.isFinite(saved) ? Math.min(Math.max(saved, 0), n - 1) : 0;
    renderReviewBtn();
    renderReview(saved > 0 ? 'resumed where you left off — Home to start over' : '');
  }

  function reviewGo(delta) {
    const n = reviewBtns().length;
    if (!n) return;
    const next = reviewIdx + delta;
    if (next >= n) {
      reviewIdx = n - 1;
      renderReview('page done — every row on this page reviewed. N = next page · Esc = close');
      return;
    }
    reviewIdx = Math.max(0, next);
    localStorage.setItem(progKey(), String(reviewIdx));
    renderReview();
  }

  // wrong match -> hand the row to the normal match pipeline. A learned pattern runs it immediately
  // (search + auto-select + the printings guard + the verify overlay); otherwise you type the #.
  function reviewFix() {
    const row = reviewRow(reviewIdx);
    if (!row) return;
    const known = fixFor(row);
    if (known) {
      reviewWrong = { name: row.name, num: row.num, set: row.set };
      reviewTarget = row;
      hideReview();
      qInput.value = known.num;
      renderRecents(known.num);
      setStatus('known bad match → ' + known.num + (setLabel(known) ? ' ' + setLabel(known) : '') + ' — verify & Enter', 'warn');
      run(row.btn, { query: known.num, setName: known.setName || '', scan: row.scan });
      return;
    }
    openFixPrompt(row);
  }
  // no pattern yet: prompt inside the overlay, autofocused, tray entries as live suggestions.
  function openFixPrompt(row) {
    if (!reviewEl) return;
    const bar = reviewEl.querySelector('#qm-rfix');
    bar.style.display = 'block';
    bar.innerHTML =
      '<div style="display:flex;gap:10px;align-items:center">' +
        '<span style="color:#ff9b9b;font-weight:700;white-space:nowrap">✗ wrong — correct #:</span>' +
        '<input id="qm-rfixin" placeholder="e.g. 54/64 or OP13-060 — or a name" ' +
          'style="flex:1;padding:8px 10px;background:#000;color:#fff;border:1px solid #666;border-radius:6px;font:14px sans-serif">' +
        '<span style="color:#888;font-size:12px;white-space:nowrap">Enter = search · Esc = back</span>' +
      '</div>' +
      '<div id="qm-rsugg" style="display:flex;gap:6px;margin-top:8px;overflow-x:auto"></div>';
    const sugg = bar.querySelector('#qm-rsugg');
    const renderSugg = f => {
      const q = f.toLowerCase();
      sugg.innerHTML = '';
      recents.filter(r => !q || (r.num || '').toLowerCase().includes(q) ||
                                (r.name || '').toLowerCase().includes(q) ||
                                (r.setName || r.set || '').toLowerCase().includes(q))
        .slice(0, 12)
        .forEach(r => {
          const chip = document.createElement('button');
          chip.textContent = [r.num, r.name].filter(Boolean).join(' · ');
          chip.style.cssText = 'flex:0 0 auto;cursor:pointer;background:#222;color:#ddd;border:1px solid #555;border-radius:14px;padding:4px 10px;font-size:12px;white-space:nowrap';
          chip.onclick = () => submitFix(row, r.num, r.setName || '');
          sugg.appendChild(chip);
        });
    };
    renderSugg('');
    fixInput = bar.querySelector('#qm-rfixin');
    fixInput.addEventListener('input', () => renderSugg(fixInput.value.trim()));
    fixInput.addEventListener('keydown', e => {
      e.stopPropagation();                                   // the review keymap must not eat typing
      if (e.key === 'Escape') { e.preventDefault(); closeFixPrompt(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const v = fixInput.value.trim();
        if (v) submitFix(row, v, '');
      }
    });
    fixInput.focus();
  }
  function closeFixPrompt() {
    const bar = reviewEl && reviewEl.querySelector('#qm-rfix');
    if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
    fixInput = null;
    if (reviewEl) reviewEl.focus();
  }
  function submitFix(row, query, setName) {
    reviewWrong = { name: row.name, num: row.num, set: row.set };
    reviewTarget = row;
    closeFixPrompt();
    hideReview();
    qInput.value = query;
    renderRecents(query);
    run(row.btn, { query, setName, scan: row.scan });
  }

  // art can still be lazy-loading when we land on a row; re-render once per row rather than sitting
  // on a "no image" placeholder. Keyed by index so a genuinely artless row can't loop forever.
  let artRetry = -1;
  function renderReview(note) {
    if (!reviewActive) return;
    const list = reviewBtns();
    if (!list.length) { setStatus('no matched rows on this page', 'warn'); return; }
    reviewIdx = Math.min(reviewIdx, list.length - 1);
    try { list[reviewIdx].scrollIntoView({ block: 'center' }); } catch (_) {}
    const row = reviewRow(reviewIdx, list);
    if (!row) return;
    if ((!row.scan || !row.catalog) && artRetry !== reviewIdx) {
      artRetry = reviewIdx;
      setTimeout(() => { if (reviewActive && artRetry === reviewIdx) renderReview(note); }, 500);
    }

    if (!reviewEl) {
      reviewEl = document.createElement('div');
      reviewEl.tabIndex = -1;
      reviewEl.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(8,8,8,.96);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:18px;font:13px sans-serif;outline:none';
      document.body.appendChild(reviewEl);
    }
    reviewEl.style.display = 'flex';

    const H = Math.round(Math.min(560, window.innerHeight * 0.52)), W = Math.round(H * 0.716);
    const known = fixFor(row);
    const pane = (src, lab, tone) =>
      '<div style="text-align:center">' +
        '<div class="qm-zwrap" style="width:' + W + 'px;height:' + H + 'px;overflow:hidden;border-radius:12px;background:#000;border:1px solid #333;cursor:crosshair">' +
          (src ? '<img class="qm-zimg" src="' + src + '" style="width:100%;height:100%;object-fit:contain;transition:transform .05s linear;will-change:transform">'
               : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666">no image</div>') +
        '</div>' +
        '<div style="margin-top:7px;font-size:13px;font-weight:600;color:' + tone + '">' + lab + '</div>' +
      '</div>';
    const field = (k, v, tone) => v
      ? '<div style="display:flex;gap:8px"><span style="color:#7d7d7d;min-width:96px">' + k + '</span>' +
        '<span style="color:' + (tone || '#eee') + ';font-weight:600">' + esc(v) + '</span></div>'
      : '';
    const conf = row.conf || '';
    const confTone = /good|high/i.test(conf) ? '#7ec27e' : /low|poor/i.test(conf) ? '#ff9b9b' : '#ffcf5a';
    const banner = known
      ? '<div style="background:#3a1414;border:1px solid #b34848;color:#ffc9c9;border-radius:8px;padding:8px 12px;font-size:13px;text-align:center">' +
          '⚠ you corrected this exact match ' + known.count + '× before → <b>' + esc(known.num) +
          (setLabel(known) ? ' · ' + esc(setLabel(known)) : '') + '</b> — press <b>X</b> to auto-fix' +
        '</div>'
      : '';

    reviewEl.innerHTML =
      '<div style="display:flex;gap:14px;align-items:center;color:#ddd">' +
        '<span style="font-size:15px;font-weight:700">Review match</span>' +
        '<span style="color:#8ab4ff;font-weight:700">' + (reviewIdx + 1) + ' / ' + list.length + '</span>' +
        (row.seq ? '<span style="color:#777">import #' + esc(row.seq) + '</span>' : '') +
        '<span id="qm-rzoom" style="color:#777"></span>' +
      '</div>' +
      banner +
      '<div style="display:flex;gap:22px;align-items:flex-start">' +
        pane(row.scan, 'your scan', '#cfe') + pane(row.catalog, 'catalog match', '#ffcf5a') +
        '<div style="min-width:250px;max-width:340px;background:#101010;border:1px solid #2a2a2a;border-radius:10px;padding:12px 14px;line-height:1.9">' +
          '<div style="font-size:17px;font-weight:700;color:#fff;margin-bottom:6px">' + esc(row.name || '—') + '</div>' +
          field('Card #', row.num, '#8ab4ff') +
          field('Set', row.set, '#ffcf5a') +
          field('Variant', row.variant) +
          field('Confidence', conf, confTone) +
          field('Listing', [row.price, row.market].filter(Boolean).join('  '), '#7ec27e') +
        '</div>' +
      '</div>' +
      '<div id="qm-rfix" style="display:none;width:min(900px,92vw);background:#141414;border:1px solid #555;border-radius:10px;padding:12px 14px"></div>' +
      '<div style="color:#9a9a9a;font-size:13px;text-align:center;line-height:1.7">' +
        '<b style="color:#7ec27e">Enter / → / ↓</b> = numbers match, next &nbsp;·&nbsp; ' +
        '<b style="color:#ff9b9b">X</b> = wrong, re-match &nbsp;·&nbsp; ' +
        '<b style="color:#ddd">← / ↑</b> back &nbsp;·&nbsp; <b style="color:#ddd">N</b> next page &nbsp;·&nbsp; ' +
        '<b style="color:#ddd">Esc</b> close' +
        (note ? '<div style="color:#ffcf3f;font-weight:700;margin-top:6px">' + esc(note) + '</div>' : '') +
      '</div>';

    zPanes = [...reviewEl.querySelectorAll('.qm-zimg')];
    for (const wrap of reviewEl.querySelectorAll('.qm-zwrap')) {
      // synced magnifier: the cursor's spot on EITHER card zooms BOTH to the same relative point —
      // the whole job is reading the # in the same corner of two images that otherwise look alike.
      wrap.addEventListener('mousemove', e => {
        const r = wrap.getBoundingClientRect();
        zPx = ((e.clientX - r.left) / r.width) * 100;
        zPy = ((e.clientY - r.top) / r.height) * 100;
        zOn = true; paintZoom();
      });
      wrap.addEventListener('mouseleave', () => { zOn = false; paintZoom(); });
      wrap.addEventListener('wheel', e => {
        e.preventDefault();
        zLevel = Math.min(6, Math.max(1.2, zLevel + (e.deltaY < 0 ? 0.3 : -0.3)));
        paintZoom();
      }, { passive: false });
    }
    paintZoom();
    reviewEl.focus();
    setStatus('reviewing ' + (reviewIdx + 1) + '/' + list.length);
  }

  async function reviewNextPage() {
    const btn = nextPageBtn();
    if (!btn) { renderReview('no next-page button found — page it yourself, then reopen review'); return; }
    const before = (reviewRow(0) || {}).seq || '';
    setStatus('next page…');
    btn.click();
    try {
      await waitFor(() => {
        const r = reviewRow(0);
        return r && r.seq && r.seq !== before ? r : null;
      }, 10000);
    } catch (_) {}
    reviewIdx = 0;
    localStorage.setItem(progKey(), '0');
    renderReview();
  }

  // the review keymap. Capture phase so it wins over the page, but never while the fix prompt is
  // taking your typing (that input stops propagation itself).
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      reviewActive ? closeReview() : openReview();
      return;
    }
    if (!reviewActive || !reviewEl || reviewEl.style.display === 'none' || fixInput) return;
    const k = e.key;
    if (k === 'Enter' || k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); reviewGo(1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); reviewGo(-1); }
    else if (k === 'x' || k === 'X' || k === 'Backspace') { e.preventDefault(); reviewFix(); }
    else if (k === 'n' || k === 'N') { e.preventDefault(); reviewNextPage(); }
    else if (k === 'Home') { e.preventDefault(); reviewIdx = 0; renderReview(); }
    else if (k === 'Escape') { e.preventDefault(); closeReview(); }
  }, true);

  reviewBtn().onclick = () => { reviewActive ? closeReview() : openReview(); };
  reviewBtn().oncontextmenu = e => {
    e.preventDefault();
    const n = Object.keys(fixes).length;
    if (!n) { setStatus('no learned patterns'); return; }
    if (confirm('Forget all ' + n + ' learned re-match pattern(s)?')) {
      fixes = {}; saveFixes(); renderReviewBtn(); setStatus('patterns cleared');
    }
  };
  renderReviewBtn();

  // Enter's happy-path state machine, factored out so the picker can trigger a search too.
  function runEnter() {
    const modal = getModal();
    if (modal) {
      const save = findBtn(modal, 'Save Match');
      if (save && !save.disabled) { hideVerify(); save.click(); setStatus('saved ✓ → next', 'ok'); }
      else if (!isNumber(qInput.value.trim())) {
        // name search: picking the first result is your call (you verify at Save)
        const sel = buttonsIn(modal).find(b => txt(b) === 'Select');
        if (sel) { sel.click(); setStatus('picked #1 — Enter to save'); }
      } else {
        // number search auto-selects the EXACT match itself — never grab a mid-load row
        setStatus('selecting… wait');
      }
      qInput.focus();
      return;
    }
    // a review re-match is in flight (its search failed, or you retyped): retry on THAT row — never
    // fall through to targetFindMatch, which hunts unmatched rows on the other tab entirely.
    if (reviewTarget) {
      run(reviewTarget.btn, { query: qInput.value.trim(), scan: reviewTarget.scan });
      return;
    }
    if (fixMode) {
      const [row] = badRows();
      if (!row) { setStatus('no mislabeled rows left ✓', 'ok'); return; }
      qInput.value = row.num;            // so the tray filters + the Save handler bank the right #
      renderRecents(row.num);
      fixRow(row);
      return;
    }
    const fm = targetFindMatch();
    if (fm) run(fm); else setStatus('no rows left');
  }
  // re-match one row to the base set of its OWN card number. The row is retired only on Save
  // (see the Save Match handler), so a failed or cancelled attempt stays queued for a retry.
  function fixRow(row) {
    pendingFixScope = row.scope;
    run(row.btn, { query: row.num, pinBaseSet: true, excludeSet: EXCLUDE_SET_RE });
  }
  renderRecents();
  updateCounter();

  // live-filter the tray by name / number / set as you type; hint a known name for a number
  qInput.addEventListener('input', () => {
    const v = qInput.value.trim();
    renderRecents(v);
    const n = (v.match(NUM_RE) || [])[0];
    if (n && v === n) {
      const names = [...new Set(recents.filter(r => r.num === n && r.name).map(r => r.name))];
      if (names.length === 1) setStatus('↳ ' + names[0] + ' (known)');
    }
  });
  // Enter = one-key happy-path state machine for blasting through best-case matches:
  //   no modal           -> open + search the topmost unmatched row (numbers auto-select)
  //   modal, none picked  -> select the FIRST result
  //   modal, Save ready   -> Save Match
  // glance between presses; if result #1 is wrong, click the right one instead, then Enter to save.
  // Esc (no TCGplayer modal open) opens the big match dialog to reuse a recent, mouse-free.
  qInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (verifyEl.style.display !== 'none') { e.preventDefault(); hideVerify(); return; }   // dismiss the compare first
      if (!getModal() && recents.length) { e.preventDefault(); openPicker(); }
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    runEnter();
  });

  // ---- capture from the SELECTED result cell (image + name + set sit with the number) ----
  function selectedCell(btn, maxUp = 8) {   // fallback: smallest ancestor whose text holds a number
    let n = btn;
    for (let i = 0; i < maxUp && n; i++) { if (NUM_RE.test(txt(n))) return n; n = n.parentElement; }
    return null;
  }
  function cardFromCell(cell) {
    if (!cell) return '';
    for (const d of cell.querySelectorAll('[data-imageurl]')) {
      const u = d.getAttribute('data-imageurl');
      if (u && u.includes('product-images')) return u;
    }
    const img = cell.querySelector('img[src*="product-images"]');
    return img ? img.src : '';
  }
  // human-readable details for a result: name / set-line (the base-vs-event-reprint tell) / #, rarity
  const VLANG = /^(English|Japanese|S-Chinese|T-Chinese|Chinese|Korean|German|French|Italian|Spanish|Portuguese)$/i;
  function selectionDetail(btn) {
    const d = resultDetails(btn);
    if (!d) return null;
    const name = txt(d.querySelector('.font-weight-600'));
    const setLine = setLineIn(d);   // e.g. "A Fist of Divine Speed(OP11)"
    const full = txt(d);
    const num = (full.match(NUM_RE) || [])[0] || '';
    let tail = '';
    if (num) {
      const parts = full.slice(full.indexOf(num) + num.length).split(',').map(s => s.trim()).filter(Boolean);
      tail = parts.filter(p => !VLANG.test(p)).slice(0, 2).join(', ');   // rarity + finish, drop language
    }
    return { name, setLine, num, tail };
  }
  function captureSelection(btn) {
    const details = resultDetails(btn);   // this result only — bleed-proof
    const row = details ? resultItemScope(details) : selectedCell(btn);
    const numText = txt(details || row || btn);
    const m = numText.match(NUM_RE); if (m) pendingNum = m[0];
    pendingCard = cardFromCell(row);
    if (details) {
      pendingName = txt(details.querySelector('.font-weight-600'));
      const setText = setLineIn(details);
      pendingSet = parenCode(setText);
      pendingSetName = setText.replace(/\s*\([^)]*\)\s*$/, '').trim();
    }
  }
  document.addEventListener('click', e => {
    // cheap gate: nothing pending. A repair can have no scan thumb (matched rows sometimes fail to
    // load their art) yet still needs its Save intercepted, so pendingFixScope also opens the gate.
    if (!pendingThumb && !pendingFixScope && !reviewTarget) return;
    const btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    const label = txt(btn);
    // bailed on the match — drop the compare, and requeue the row so Enter offers it again
    if (label === 'Cancel') {
      hideVerify();
      pendingFixScope = null;
      if (reviewTarget) {                       // back to the same row, still unapproved
        reviewTarget = null; reviewWrong = null;
        if (reviewActive) renderReview('re-match cancelled — row left as it was');
      }
      return;
    }
    if (label !== 'Select' && label !== 'Save Match') return;   // skip getModal for normal clicks
    if (!getModal()) return;
    if (label === 'Select') {
      captureSelection(btn);
      setStatus('picked — Save to keep');
      // only on a real mouse pick (isTrusted); the auto-select path shows its own verify with fresh art
      if (e.isTrusted) showVerify(pendingThumb, pendingCard, selectionDetail(btn));
    } else if (label === 'Save Match') {
      hideVerify();
      addRecent({ scan: pendingThumb, catalog: pendingCard, num: pendingNum || pendingQuery,
                  name: pendingName, set: pendingSet, setName: pendingSetName });
      lastSaved = recents[0];
      sessionCount++; updateCounter();
      if (pendingFixScope) {
        fixedRows.add(pendingFixScope);   // retire the row: it's corrected, don't offer it again
        pendingFixScope = null;
        renderFix();                      // the counter drops even before React repaints the row
        setStatus('fixed ✓ — ' + badRows().length + ' left', 'ok');
      } else if (reviewTarget) {
        // bank the pattern (wrong match -> the one you just picked) and walk on. The scanner repeats
        // itself, so the next row with this same wrong match auto-fills the correction.
        recordFix(reviewWrong, { num: pendingNum || pendingQuery, name: pendingName, set: pendingSet,
                                 setName: pendingSetName, catalog: pendingCard, scan: pendingThumb });
        const learned = wrongKey(reviewWrong || {});
        reviewTarget = null; reviewWrong = null;
        setStatus('re-matched ✓ — pattern learned', 'ok');
        if (reviewActive) setTimeout(() => {          // let React repaint the row before we re-read it
          if (reviewActive) reviewGo(1);
        }, 700);
        console.debug('[QuickMatch] learned re-match for', learned);
      } else {
        setStatus('saved to tray ✓');
      }
      pendingThumb = null; pendingNum = ''; pendingCard = '';
      pendingName = ''; pendingSet = ''; pendingSetName = '';
    }
  }, true);

  async function run(findMatchBtn, opts = {}) {
    const query = (opts.query || qInput.value).trim();
    if (!query) { setStatus('type a # or name'); qInput.focus(); return; }
    hideVerify();                          // clear any prior card's comparison before starting a new one
    try { findMatchBtn.scrollIntoView({ block: 'center' }); } catch (_) {}   // show which row we're on
    // opts.scan: on a MATCHED row the nearest image may be the catalog art, not the scan — review mode
    // already read the row's captioned scan, so it hands it over rather than letting us guess.
    pendingThumb = opts.scan || getRowScan(findMatchBtn);
    pendingQuery = query;
    pendingNum = ''; pendingCard = ''; pendingName = ''; pendingSet = ''; pendingSetName = '';
    try { await quickMatch(findMatchBtn, query, setStatus, opts); }
    catch (e) {
      console.error('[QuickMatch]', e);
      setStatus('failed: ' + e.message, 'warn');
      pendingFixScope = null;              // a failed repair must not retire its row
    }
    qInput.focus();   // keep Enter routed to the happy-path state machine
  }

  function decorate() {
    for (const b of [...document.querySelectorAll('button')]) {
      const label = txt(b);
      if (label === FIND_MATCH && !b.dataset.qmDone) {
        b.dataset.qmDone = '1';
        const zap = document.createElement('button');
        zap.textContent = '⚡';
        zap.title = 'Quick match using the box bottom-left';
        zap.style.cssText = 'margin-left:6px;cursor:pointer;font-size:14px';
        zap.onclick = e => { e.preventDefault(); run(b); };
        b.after(zap);
      } else if (label === FIND_NEW && !b.dataset.qmFixDone) {
        b.dataset.qmFixDone = '1';
        // on every matched row, not just the bad ones: the row's set text may not have painted yet
        // when we decorate, and we only get one shot per button. It reads the row fresh on click.
        const wrench = document.createElement('button');
        wrench.textContent = '🔧';
        wrench.title = 'Re-match this row to the base set of its own card number';
        wrench.style.cssText = 'margin-left:6px;cursor:pointer;font-size:14px';
        wrench.onclick = e => {
          e.preventDefault();
          const scope = rowScopeOf(b, FIND_NEW), num = rowNumberOf(scope);
          if (!num) { setStatus('no card # on that row', 'warn'); return; }
          qInput.value = num;
          renderRecents(num);
          fixRow({ btn: b, scope, num });
        };
        b.after(wrench);
      }
    }
  }
  // debounce to one decorate per frame — TCGplayer's SPA mutates the DOM constantly
  let decorateQueued = false;
  function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => { decorateQueued = false; decorate(); });
  }
  new MutationObserver(scheduleDecorate).observe(document.body, { childList: true, subtree: true });
  decorate();
})();
