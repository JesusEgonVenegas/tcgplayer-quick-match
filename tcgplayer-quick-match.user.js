// ==UserScript==
// @name         TCGplayer Quick Match
// @namespace    https://github.com/JesusEgonVenegas
// @version      1.0.0
// @description  Fast keyboard-driven catalog matching for the TCGplayer Seller Portal scan-identify page — One Piece & Pokémon, with a base-vs-reprint/parallel guard, an auto scan-vs-catalog verifier, and dynamic phantom-row skipping.
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
  // the set code in parens on a result, e.g. "Carrying On His Will(OP13)" -> "OP13",
  // "...3rd Anniversary... (OP13 ANN)" -> "OP13 ANN". This is what tells base from reprint.
  function setCodeOf(btn) {
    const d = resultDetails(btn);
    const t = d ? txt(d.querySelector('.color-surface-subdued')) : '';
    const m = t.match(/\(([^)]+)\)\s*$/) || t.match(/\(([^)]+)\)/);
    return m ? m[1] : '';
  }

  async function quickMatch(findMatchBtn, query, setStatus) {
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
    const prefSet = setPrefix ? (learnedSet || setPrefix) : '';
    setStatus('searching…' + (learnedName ? ' →' + learnedName : prefSet ? ' [' + prefSet + ']' : ''));
    await triggerSearch(modal, input, query);

    if (isNumber(query)) {
      setStatus('selecting…');
      const nameOf = b => { const d = resultDetails(b); return d ? txt(d.querySelector('.font-weight-600')) : ''; };
      const exact = () => buttonsIn(modal).filter(b => txt(b) === 'Select')
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
        if (learnedName) { const nm = c.filter(b => nameOf(b).toLowerCase() === learnedName.toLowerCase()); if (nm.length) c = nm; else if (strict) return []; }
        return c;
      }
      const pick = () => { const c = narrow(true); return c.length ? c[0] : null; };
      // wait for the preferred result; if it never resolves (stale set/name), fall back to first exact match
      const preferred = learnedName || prefSet;
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
  const findMatchBtns = () => [...document.querySelectorAll('button')]
    .filter(b => txt(b) === 'Find Match' && b.getClientRects().length)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
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
    const fm = targetFindMatch();
    if (fm) run(fm); else setStatus('no rows left');
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
    const setLine = txt(d.querySelector('.color-surface-subdued'));   // e.g. "A Fist of Divine Speed(OP11)"
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
      const setText = txt(details.querySelector('.color-surface-subdued'));
      const sm = setText.match(/\(([^)]+)\)\s*$/) || setText.match(/\(([^)]+)\)/);
      pendingSet = sm ? sm[1] : '';
      pendingSetName = setText.replace(/\s*\([^)]*\)\s*$/, '').trim();
    }
  }
  document.addEventListener('click', e => {
    if (!pendingThumb) return;                                  // cheap gate: nothing pending
    const btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    const label = txt(btn);
    if (label === 'Cancel') { hideVerify(); return; }           // bailed on the match — drop the compare
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
      setStatus('saved to tray ✓');
      pendingThumb = null; pendingNum = ''; pendingCard = '';
      pendingName = ''; pendingSet = ''; pendingSetName = '';
    }
  }, true);

  async function run(findMatchBtn) {
    const query = qInput.value.trim();
    if (!query) { setStatus('type a # or name'); qInput.focus(); return; }
    hideVerify();                          // clear any prior card's comparison before starting a new one
    try { findMatchBtn.scrollIntoView({ block: 'center' }); } catch (_) {}   // show which row we're on
    pendingThumb = getRowScan(findMatchBtn);
    pendingQuery = query;
    pendingNum = ''; pendingCard = ''; pendingName = ''; pendingSet = ''; pendingSetName = '';
    try { await quickMatch(findMatchBtn, query, setStatus); }
    catch (e) { console.error('[QuickMatch]', e); setStatus('failed: ' + e.message); }
    qInput.focus();   // keep Enter routed to the happy-path state machine
  }

  function decorate() {
    for (const b of [...document.querySelectorAll('button')]) {
      if (txt(b) !== 'Find Match' || b.dataset.qmDone) continue;
      b.dataset.qmDone = '1';
      const zap = document.createElement('button');
      zap.textContent = '⚡';
      zap.title = 'Quick match using the box bottom-left';
      zap.style.cssText = 'margin-left:6px;cursor:pointer;font-size:14px';
      zap.onclick = e => { e.preventDefault(); run(b); };
      b.after(zap);
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
