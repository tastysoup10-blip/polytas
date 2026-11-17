/*
 * The input editor, one part of the TAS window (window.js). It shows the inputs of the car you watch in the
 * game's Replay Editor, and follows it when you switch cars. Nothing changes in the game until you Apply
 * (Ctrl+Enter); then that car runs again with these inputs. Typing is checked as you go: problems are marked
 * by their line, and a run with an error is not sent.
 *
 * Talks to the game window through window.tasBridge (electron/window-preload.js).
 */
(function () {
  'use strict';
  const I = window.TASInputs;
  const $ = (id) => document.getElementById(id);
  const bridge = window.tasBridge || { send() {}, onMessage() {}, focusGame() {}, saveFile: async () => null, openFile: async () => null };
  const W = window.TASWindow;
  const PREFS = 'tas-v1-editor';

  const ACTIONS = [
    ['apply', 'Apply (run the car with these inputs)', 'Ctrl+Enter'],
    ['insert', 'Add a line at the replay\'s moment', 'Ctrl+KeyI'],
    ['gotoTime', 'Replay to this line\'s time', 'Ctrl+KeyG'],
    ['playPause', 'Play / pause the replay', 'Ctrl+Space'],
    ['back1', 'Replay back 1 ms', 'Alt+ArrowLeft'],
    ['fwd1', 'Replay forward 1 ms', 'Alt+ArrowRight'],
    ['back10', 'Replay back 10 ms', 'Alt+Shift+ArrowLeft'],
    ['fwd10', 'Replay forward 10 ms', 'Alt+Shift+ArrowRight'],
    ['nextCar', 'Next car', 'Ctrl+Tab'],
    ['prevCar', 'Previous car', 'Ctrl+Shift+Tab'],
    ['compact', 'Compact', 'Ctrl+Shift+KeyM'],
    ['sort', 'Sort', 'Ctrl+Shift+KeyO'],
    ['save', 'Save to a file', 'Ctrl+KeyS'],
    ['open', 'Open a file', 'Ctrl+KeyO'],
  ];

  const state = {
    cars: [], focus: 0, track: null,
    car: null,                         // { index, name, kind, applied, original }
    parsed: { items: [], problems: [] },
    replay: { t: null, keys: 0, paused: true, index: -1 },
    applying: null, draftTimer: 0, dirtyRender: false, attached: false,
    prefs: null,
  };

  // ------------------------------------------------------------------ preferences
  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { p = {}; }
    const keys = {};
    for (const [id, , def] of ACTIONS) keys[id] = p.keys && typeof p.keys[id] === 'string' ? p.keys[id] : def;
    state.prefs = { fontSize: Number(p.fontSize) || 15, tail: Number(p.tail) || 5000, keys };
  }
  function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(state.prefs)); } catch { } }
  function applyPrefs() {
    const f = Math.max(10, Math.min(28, state.prefs.fontSize));
    view.lh = Math.round(f * 1.34);
    document.documentElement.style.setProperty('--font', f + 'px');
    document.documentElement.style.setProperty('--line', view.lh + 'px');
    scheduleRender();
  }

  // ------------------------------------------------------------------ elements
  const ta = $('text'), hlText = $('hlText'), gutter = $('gutter'), gutterLines = $('gutterLines'), nowline = $('nowline');
  const PAD = 6;
  const lineHeight = () => view.lh;
  /**
   * What is drawn. The textarea holds the text, invisible; under it the highlight layer, and beside it the
   * line numbers, draw only the lines in view (and OVERSCAN around them), placed where the textarea has
   * them — so a TAS of tens of thousands of lines types and scrolls like a short one.
   */
  const OVERSCAN = 20;
  const view = { lh: 20, rows: [''], first: -1, last: -1, err: new Set(), warn: new Set(), index: [], byLine: new Map(), nowEl: null };

  const fmtMs = (ms) => (ms == null ? '—' : ms + ' ms');
  const fmtTime = (ms) => {
    if (ms == null || !isFinite(ms)) return '—';
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return (m ? m + ':' + String(s).padStart(2, '0') : String(s)) + '.' + String(r).padStart(3, '0');
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function setStatus(text, cls) { const s = $('status'); s.textContent = text; s.title = text; s.className = cls || 'dim'; }
  /** "−0.026 vs Monstrosity": a finish against what it is measured by. */
  const vsText = (finish, ref) => {
    if (finish == null || !ref) return '';
    const d = finish - ref.ms;
    return ' (' + (d > 0 ? '+' : d < 0 ? '−' : '±') + fmtTime(Math.abs(d)) + ' vs ' + ref.label + ')';
  };

  // ------------------------------------------------------------------ drawing the text
  // After an edit, on the next frame: the lines in view (always fresh), and the check of the whole text —
  // at once for a text of up to LONG lines, a moment after you stop typing for a longer one (a line's own
  // errors are marked as you type either way; notes and the problems list follow the whole check).
  const LONG = 3000;
  let paintQueued = false, parseTimer = 0;
  function scheduleRender() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      clearTimeout(parseTimer);
      view.rows = ta.value.split('\n');
      if (view.rows.length <= LONG) reparse();
      else { paintText(true); parseTimer = setTimeout(reparse, 150); }
    });
  }
  /** Everything at once (before Apply and the like). */
  function render() { reparse(); }

  function keysHtml(k) {
    if (/^none$/i.test(k)) return '<span class="t-none">' + esc(k) + '</span>';
    let out = '';
    for (const ch of k) out += /[wasdr]/i.test(ch) ? '<span class="k-' + ch.toLowerCase() + '">' + esc(ch) + '</span>' : '<span class="t-bad">' + esc(ch) + '</span>';
    return out;
  }

  function lineHtml(raw, bad) {
    const hash = raw.indexOf('#');
    const body = hash >= 0 ? raw.slice(0, hash) : raw, com = hash >= 0 ? raw.slice(hash) : '';
    let out;
    if (bad && body.trim()) out = '<span class="t-bad">' + esc(body) + '</span>';
    else {
      const tap = /^(\s*)(tap)(\s+)(\d+)(\s+)(\d+)(\s+)(\S+)(\s+)(\d+)(\s+)(\d+)(\s*)$/i.exec(body);
      const plain = /^(\s*)(\d+)(\s*,\s*)(\S*)(\s*)$/.exec(body);
      if (tap) out = esc(tap[1]) + '<span class="t-tap">' + esc(tap[2]) + '</span>' + esc(tap[3]) + '<span class="t-time">' + tap[4] + '</span>' + esc(tap[5])
        + '<span class="t-time">' + tap[6] + '</span>' + esc(tap[7]) + keysHtml(tap[8]) + esc(tap[9]) + '<span class="t-time">' + tap[10] + '</span>' + esc(tap[11])
        + '<span class="t-time">' + tap[12] + '</span>' + esc(tap[13]);
      else if (plain) out = esc(plain[1]) + '<span class="t-time">' + plain[2] + '</span><span class="t-comma">' + esc(plain[3]) + '</span>' + keysHtml(plain[4]) + esc(plain[5]);
      else out = esc(body);
    }
    return out + (com ? '<span class="t-com">' + esc(com) + '</span>' : '');
  }

  /** The whole text checked: its problems, the notes by the line numbers, and which line is in effect when. */
  function reparse() {
    clearTimeout(parseTimer);
    parseTimer = 0;
    const text = ta.value;
    view.rows = text.split('\n');
    state.parsed = I.parse(text);
    view.err = new Set(); view.warn = new Set();
    for (const p of state.parsed.problems) (p.level === 'error' ? view.err : view.warn).add(p.line);
    // every line and tap by the moment it starts (then by line): the latest one at or before a moment is in effect
    view.index = state.parsed.items.map((it) => [it.kind === 'line' ? it.t : it.start, it.line]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    view.byLine = new Map(state.parsed.items.map((it) => [it.line, it]));
    const pr = $('problems');
    pr.textContent = '';
    for (const p of state.parsed.problems.slice(0, 200)) {
      const d = document.createElement('div');
      d.className = p.level === 'error' ? 'err' : 'warn';
      d.innerHTML = '<b>' + (p.level === 'error' ? 'Error' : 'Note') + '</b> line ' + p.line + ': ' + esc(p.message);
      d.addEventListener('click', () => gotoLine(p.line));
      pr.appendChild(d);
    }
    $('apply').disabled = !state.car || view.err.size > 0;
    paintText(true);
    paintHeader();
  }

  /** The lines in view (and OVERSCAN around them): highlighted text and line numbers, moved with the textarea's scroll. */
  function paintText(force) {
    const lh = view.lh, top = ta.scrollTop, height = ta.clientHeight || 600, n = view.rows.length;
    const first = Math.max(0, Math.min(n - 1, Math.floor((top - PAD) / lh) - OVERSCAN));
    const last = Math.max(first, Math.min(n - 1, Math.ceil((top + height - PAD) / lh) + OVERSCAN));
    if (force || first !== view.first || last !== view.last) {
      view.first = first; view.last = last;
      let html = '';
      const frag = document.createDocumentFragment();
      for (let i = first; i <= last; i++) {
        const raw = view.rows[i];
        const bad = I.lineError(raw) != null;
        html += (i > first ? '\n' : '') + lineHtml(raw, bad);
        const d = document.createElement('div');
        d.textContent = i + 1;
        d.dataset.line = i + 1;
        if (bad) d.className = 'err'; else if (view.warn.has(i + 1)) d.className = 'warn';
        frag.appendChild(d);
      }
      hlText.innerHTML = html;
      gutterLines.textContent = '';
      gutterLines.appendChild(frag);
      view.nowEl = null;
    }
    // the numbers' column fits the longest number (a monospace font: ch is one digit)
    const digits = Math.max(3, String(n).length);
    if (digits !== view.digits) { view.digits = digits; gutter.style.width = 'calc(' + digits + 'ch + 30px)'; }
    const y = PAD + first * lh - top;
    hlText.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + y + 'px)';
    gutterLines.style.transform = 'translateY(' + y + 'px)';
    paintNow();
  }

  function syncScroll() { paintText(false); }

  /** The line in effect at the replay's moment: the latest line (or tap) starting at or before it (a binary search). */
  function activeLine(t) {
    if (t == null) return -1;
    const ix = view.index;
    let lo = 0, hi = ix.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ix[m][0] <= t) lo = m + 1; else hi = m; }
    return lo > 0 ? ix[lo - 1][1] : -1;
  }

  /** While you are not working in the text, the line in effect stays in view as the replay moves. */
  let lastUserAt = 0;
  function follow() {
    if (!state.car || state.replay.index !== state.car.index || performance.now() - lastUserAt < 1500) return;
    const line = activeLine(state.replay.t);
    if (line < 1) return;
    const lh = lineHeight(), top = PAD + (line - 1) * lh;
    if (top < ta.scrollTop || top + lh > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  }

  function paintNow() {
    const line = activeLine(state.replay.t);
    const show = line >= 1 && !!state.car && state.replay.index === state.car.index;
    const el = show && line - 1 >= view.first && line - 1 <= view.last ? gutterLines.children[line - 1 - view.first] || null : null;
    if (view.nowEl !== el) {
      if (view.nowEl) view.nowEl.classList.remove('now');
      if (el) el.classList.add('now');
      view.nowEl = el;
    }
    if (!show) { nowline.style.display = 'none'; return; }
    nowline.style.display = 'block';
    nowline.style.top = (PAD + (line - 1) * view.lh - ta.scrollTop) + 'px';
  }

  function paintHeader() {
    const info = $('carinfo');
    info.textContent = '';
    const car = state.car;
    if (!car) return;
    const meta = state.cars.find((c) => c.index === car.index);
    const parts = [];
    if (meta && meta.done && meta.finish != null) parts.push('<span class="good">finish ' + fmtTime(meta.finish) + '</span>' + esc(vsText(meta.finish, meta.ref)));
    else if (meta && meta.done) parts.push('<span class="dim">does not finish</span>');
    else if (meta) parts.push('<span class="warn">simulating…</span>');
    if (ta.value !== car.applied) parts.push('<span class="warn">unapplied changes</span>');
    else if (meta && meta.modified) parts.push('<span class="warn">edited</span>');
    info.innerHTML = parts.join(' · ');
    $('revert').disabled = car.kind !== 'run';
  }

  function renderCars() {
    const sel = $('car');
    sel.textContent = '';
    for (const c of state.cars) {
      const o = document.createElement('option');
      o.value = c.index;
      o.textContent = (c.index + 1) + '. ' + c.name + (c.modified ? ' — edited' : '') + (c.hasDraft ? ' — unapplied' : '');
      sel.appendChild(o);
    }
    sel.value = state.focus;
    if (W) W.setTitle(state.track ? state.track.name : '');
  }

  function gotoLine(line) {
    const rows = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < rows.length; i++) pos += rows[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (rows[line - 1] || '').length);
    const top = PAD + (line - 1) * lineHeight();
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lineHeight()) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  }

  // ------------------------------------------------------------------ big changes
  // The browser's undoable "insert text" slows down with the square of the lines it inserts (measured:
  // 250 lines 56 ms, 1 000 lines 0.63 s, 2 000 lines 2.5 s — and pasting goes the same way). So a change
  // of more than BULK lines (Compact, Sort, Open, Revert, a paste) sets the text instead, at once, with an
  // undo of its own: Ctrl+Z brings back the text from before it (straight away, or once the browser has
  // undone your typing since), Ctrl+Y or Ctrl+Shift+Z makes it again. Typing stays the browser's own.
  const BULK = 200;
  const bulk = { undo: [], redo: [] };
  const linesIn = (s) => { let n = 0; for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++; return n; };
  function setBulk(text, caret) {
    bulk.undo.push({ before: ta.value, after: text, sel: [ta.selectionStart, ta.selectionEnd] });
    if (bulk.undo.length > 30) bulk.undo.shift();
    bulk.redo.length = 0;
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(caret, caret);
  }
  function bulkUndo() {
    const u = bulk.undo[bulk.undo.length - 1];
    if (!u || ta.value !== u.after) return false;
    bulk.undo.pop(); bulk.redo.push(u);
    ta.value = u.before; ta.setSelectionRange(u.sel[0], u.sel[1]);
    onEdit();
    return true;
  }
  function bulkRedo() {
    const r = bulk.redo[bulk.redo.length - 1];
    if (!r || ta.value !== r.before) return false;
    bulk.redo.pop(); bulk.undo.push(r);
    ta.value = r.after; ta.setSelectionRange(0, 0);
    onEdit();
    return true;
  }

  /** Replace the whole text, in a way Ctrl+Z can take back. */
  function replaceAll(text) {
    if (ta.value === text) { onEdit(); return; }
    if (linesIn(text) > BULK || linesIn(ta.value) > BULK) setBulk(text, 0);
    else { ta.focus(); ta.select(); if (!document.execCommand('insertText', false, text)) ta.value = text; }
    onEdit();
  }

  // ------------------------------------------------------------------ actions
  function cursorLine() { return ta.value.slice(0, ta.selectionStart).split('\n').length; }
  function lineTime(line) {
    const it = view.byLine.get(line);
    return it ? (it.kind === 'line' ? it.t : it.start) : null;
  }

  const actions = {
    apply() {
      if (!state.car) return;
      render();
      if (state.parsed.problems.some((p) => p.level === 'error')) { setStatus('Fix the errors first — nothing was sent', 'bad'); return; }
      state.applying = { index: state.car.index, at: performance.now(), text: ta.value };
      clearTimeout(state.draftTimer);
      state.draftTimer = 0;
      setStatus('Simulating…', 'busy');
      bridge.send({ type: 'apply', index: state.car.index, text: ta.value });
    },
    insert() {
      const t = state.replay.t;
      if (t == null) { setStatus('No replay moment yet', 'bad'); return; }
      const keys = I.keysText(state.replay.keys);
      const rows = ta.value.split('\n');
      // a line at exactly that moment: select its keys instead of adding another
      const same = state.parsed.items.find((x) => x.kind === 'line' && x.t === t);
      if (same) {
        const row = rows[same.line - 1];
        const comma = row.indexOf(',');
        let pos = 0;
        for (let i = 0; i < same.line - 1; i++) pos += rows[i].length + 1;
        const end = row.replace(/\s*#.*/, '').length;
        ta.focus(); ta.setSelectionRange(pos + comma + 1, pos + end);
        return;
      }
      // after the line in effect at that moment (or at the top, under any header comments)
      let after = activeLine(t);
      if (after < 1) { after = 0; while (after < rows.length && /^\s*(#.*)?$/.test(rows[after])) after++; }
      let pos = 0;
      for (let i = 0; i < after; i++) pos += rows[i].length + 1;
      const insertAtEnd = after >= rows.length;
      const piece = (insertAtEnd && ta.value.length && !ta.value.endsWith('\n') ? '\n' : '') + t + ',' + keys + (insertAtEnd ? '' : '\n');
      ta.focus();
      ta.setSelectionRange(Math.min(pos, ta.value.length), Math.min(pos, ta.value.length));
      document.execCommand('insertText', false, piece);
      const lineStart = Math.min(pos, ta.value.length) + (piece.startsWith('\n') ? 1 : 0);
      const keyStart = lineStart + String(t).length + 1;
      ta.setSelectionRange(keyStart, keyStart + keys.length);
      onEdit();
    },
    gotoTime() {
      const t = lineTime(cursorLine());
      if (t == null) { setStatus('This line has no time', 'bad'); return; }
      bridge.send({ type: 'seek', t });
    },
    playPause() { bridge.send({ type: 'pause', paused: !state.replay.paused }); },
    back1() { seekBy(-1); }, fwd1() { seekBy(1); }, back10() { seekBy(-10); }, fwd10() { seekBy(10); },
    nextCar() { switchCar(1); }, prevCar() { switchCar(-1); },
    compact() {
      render();
      if (state.parsed.problems.some((p) => p.level === 'error')) { setStatus('Fix the errors first', 'bad'); return; }
      const before = ta.value.split('\n').filter((l) => l.trim()).length;
      const text = I.compact(I.expand(state.parsed.items));
      replaceAll(text);
      setStatus('Compacted: ' + before + ' → ' + text.split('\n').filter((l) => l.trim()).length + ' lines, same run', 'good');
    },
    sort() { replaceAll(I.sortText(ta.value)); setStatus('Sorted by time', 'good'); },
    async save() {
      const name = ((state.track ? state.track.name : 'track') + ' - ' + (state.car ? state.car.name : 'inputs')).replace(/[\\/:*?"<>|]+/g, '') + '.txt';
      const saved = await bridge.saveFile(name, ta.value);
      if (saved) setStatus('Saved ' + saved, 'good');
    },
    async open() {
      const r = await bridge.openFile();
      if (!r) return;
      if (r.error) { setStatus(r.error, 'bad'); return; }
      replaceAll(r.text.replace(/\r\n?/g, '\n'));
      setStatus('Opened ' + r.name + ' — Apply to run it', 'good');
    },
  };

  function seekBy(ms) { if (state.replay.t != null) bridge.send({ type: 'seek', t: Math.max(0, state.replay.t + ms) }); }
  function switchCar(dir) {
    if (!state.cars.length) return;
    const n = state.cars.length;
    sendDraftNow();
    bridge.send({ type: 'focus', index: ((state.focus + dir) % n + n) % n });
  }

  // ------------------------------------------------------------------ drafts and edits
  function onEdit() {
    scheduleRender();
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(sendDraftNow, 400);
  }
  function sendDraftNow() {
    clearTimeout(state.draftTimer);
    state.draftTimer = 0;
    if (state.car) bridge.send({ type: 'draft', index: state.car.index, text: ta.value });
  }

  // ------------------------------------------------------------------ messages from the game
  bridge.onMessage((msg) => {
    switch (msg.type) {
      case 'state':
        state.attached = true; if (W) W.detached('inputs', false);
        state.cars = msg.cars; state.focus = msg.focus; state.track = msg.track;
        renderCars(); paintHeader();
        break;
      case 'load': {
        state.attached = true; if (W) W.detached('inputs', false);
        const same = !!state.car && state.car.index === msg.index;
        // typing on the car you just left that has not gone to the game yet goes now, before its text is replaced
        if (!same && state.car && state.draftTimer) sendDraftNow();
        state.car = { index: msg.index, name: msg.name, kind: msg.kind, applied: msg.applied, original: msg.original };
        state.focus = msg.index;
        $('car').value = msg.index;
        if (!same) {
          ta.value = msg.text;
          bulk.undo.length = bulk.redo.length = 0;     // another car's text: its undo is not this one's
          ta.scrollTop = 0;
          ta.setSelectionRange(0, 0);
          setStatus(msg.kind === 'tas' ? 'Editing the TAS car' : 'Editing ' + msg.name + '\'s run', 'dim');
        } else if (msg.text !== ta.value && !state.draftTimer) ta.value = msg.text;   // changed in the game (your own unsent typing is newer, and stays)
        render();
        break;
      }
      case 'time':
        state.replay = { t: msg.t, keys: msg.keys, paused: msg.paused, index: msg.index };
        $('time').textContent = fmtMs(msg.t);
        for (const i of $('keys').children) i.classList.toggle('on', !!(msg.keys & I.BIT[i.dataset.k]));
        $('play').textContent = msg.paused ? 'paused' : 'playing';
        follow();
        paintNow();
        break;
      case 'applied':
        if (state.car && msg.index === state.car.index) {
          if (msg.ok) {
            const was = state.applying;
            if (was && was.index === msg.index) state.car.applied = was.text;
            setStatus('Applied in ' + msg.ms + ' ms' + (msg.from > 0 ? ' (from ' + fmtTime(msg.from) + ')' : '') + ' · '
              + (msg.finish != null ? 'finish ' + fmtTime(msg.finish) : 'does not finish'), 'good');
          } else setStatus('Not applied: ' + msg.error, 'bad');
        }
        state.applying = null;
        paintHeader();
        break;
      case 'detached':
        state.attached = false; state.car = null; state.cars = [];
        if (W) W.detached('inputs', true);
        setStatus('Waiting for the game…', 'dim');
        break;
    }
  });

  // ------------------------------------------------------------------ keys
  function comboOf(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    return (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + e.code;
  }
  const comboLabel = (c) => (c || '—').replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');

  let listening = null;
  document.addEventListener('keydown', (e) => {
    if (listening) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { listening.btn.classList.remove('listening'); listening.btn.textContent = comboLabel(state.prefs.keys[listening.id]); listening = null; return; }
      const c = comboOf(e);
      if (!c) return;
      state.prefs.keys[listening.id] = c; savePrefs();
      listening.btn.classList.remove('listening'); listening.btn.textContent = comboLabel(c); listening = null;
      return;
    }
    if (!$('settings').classList.contains('hidden')) { if (e.key === 'Escape') closeSettings(); return; }
    if (!$('help').classList.contains('hidden')) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); $('help').classList.add('hidden'); } return; }
    // the editor's keys only while it is the part in use (with both showing: the one last clicked or typed in)
    if (W && !W.active('inputs')) return;
    // undo / redo of a big change (see BULK); anything else is the browser's own
    if (e.ctrlKey && !e.altKey && e.code === 'KeyZ' && !e.shiftKey) { if (bulkUndo()) { e.preventDefault(); return; } }
    if (e.ctrlKey && !e.altKey && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) { if (bulkRedo()) { e.preventDefault(); return; } }
    const c = comboOf(e);
    if (!c) return;
    for (const [id] of ACTIONS) {
      if (state.prefs.keys[id] === c) { e.preventDefault(); actions[id](); return; }
    }
  }, true);

  // ------------------------------------------------------------------ settings panel
  function openSettings() {
    $('fontSize').value = state.prefs.fontSize;
    $('tail').value = state.prefs.tail;
    const box = $('shortcuts');
    box.textContent = '';
    for (const [id, label] of ACTIONS) {
      const row = document.createElement('div');
      const span = document.createElement('span'); span.textContent = label;
      const btn = document.createElement('button'); btn.textContent = comboLabel(state.prefs.keys[id]);
      btn.addEventListener('click', () => {
        if (listening) { listening.btn.classList.remove('listening'); listening.btn.textContent = comboLabel(state.prefs.keys[listening.id]); }
        listening = { id, btn }; btn.classList.add('listening'); btn.textContent = 'press keys… (Esc: cancel)';
      });
      row.append(span, btn); box.appendChild(row);
    }
    $('settings').classList.remove('hidden');
  }
  function closeSettings() {
    state.prefs.fontSize = Math.max(10, Math.min(28, Number($('fontSize').value) || 15));
    state.prefs.tail = Math.max(500, Math.min(60000, Number($('tail').value) || 5000));
    savePrefs(); applyPrefs();
    bridge.send({ type: 'prefs', prefs: { tail: state.prefs.tail } });
    $('settings').classList.add('hidden');
    listening = null;
  }

  // ------------------------------------------------------------------ wiring
  ta.addEventListener('input', onEdit);
  // a long paste goes in at once (the browser's own would take seconds; see BULK)
  ta.addEventListener('paste', (e) => {
    const text = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r\n?/g, '\n');
    if (linesIn(text) <= BULK) return;
    e.preventDefault();
    const v = ta.value, s = ta.selectionStart, end = ta.selectionEnd;
    setBulk(v.slice(0, s) + text + v.slice(end), s + text.length);
    onEdit();
  });
  ta.addEventListener('scroll', syncScroll);
  window.addEventListener('resize', () => paintText(false));
  // shown again (another tab, or both side by side): drawn for its new size
  if (W) W.onView(() => requestAnimationFrame(() => paintText(true)));
  for (const ev of ['keydown', 'mousedown', 'wheel']) ta.addEventListener(ev, () => { lastUserAt = performance.now(); }, { passive: true });
  // the wheel over the line numbers scrolls the text too
  gutter.addEventListener('wheel', (e) => { lastUserAt = performance.now(); ta.scrollTop += e.deltaMode === 1 ? e.deltaY * view.lh : e.deltaY; }, { passive: true });
  ta.addEventListener('keydown', (e) => {
    // Tab writes spaces rather than leaving the text
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  gutter.addEventListener('click', (e) => {
    const line = Number(e.target && e.target.dataset && e.target.dataset.line);
    if (!line) return;
    const t = lineTime(line);
    if (t != null) bridge.send({ type: 'seek', t });
  });
  $('car').addEventListener('change', () => { sendDraftNow(); bridge.send({ type: 'focus', index: Number($('car').value) }); });
  for (const id of ['apply', 'insert', 'compact', 'sort', 'save', 'open']) $(id).addEventListener('click', () => actions[id]());
  $('revert').addEventListener('click', () => {
    if (!state.car || state.car.kind !== 'run' || state.car.original == null) return;
    replaceAll(state.car.original);
    actions.apply();
  });
  $('copy').addEventListener('click', () => { navigator.clipboard.writeText(ta.value).then(() => setStatus('Copied', 'good'), () => setStatus('Could not copy', 'bad')); });
  $('settingsBtn').addEventListener('click', openSettings);
  $('helpBtn').addEventListener('click', () => {
    const box = $('helpKeys');
    box.textContent = '';
    for (const [id, label] of ACTIONS) {
      const row = document.createElement('div');
      const span = document.createElement('span'); span.textContent = label;
      const key = document.createElement('b'); key.textContent = comboLabel(state.prefs.keys[id]);
      row.append(span, key); box.appendChild(row);
    }
    $('help').classList.remove('hidden');
  });
  $('closeHelp').addEventListener('click', () => $('help').classList.add('hidden'));
  $('closeSettings').addEventListener('click', closeSettings);
  $('resetKeys').addEventListener('click', () => { for (const [id, , def] of ACTIONS) state.prefs.keys[id] = def; savePrefs(); openSettings(); });
  window.addEventListener('beforeunload', sendDraftNow);

  loadPrefs();
  applyPrefs();
  render();
  bridge.send({ type: 'hello' });
  bridge.send({ type: 'prefs', prefs: { tail: state.prefs.tail } });
  window.TASEditor = { state, actions, render, ta, replaceAll, view, paintText };
})();
