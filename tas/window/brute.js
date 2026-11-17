/*
 * The bruteforce, one part of the TAS window (window.js): what to aim for (objectives), what may change, how
 * tries are scored, and the search; and every new best it finds. What it works on lives in the game window
 * (tas/tas-brute.js) — the objectives and settings are kept there, per track — so this part only shows them
 * and sends changes back. It follows the car you watch in the Replay Editor.
 *
 * Talks to the game window through window.tasBruteBridge (electron/window-preload.js).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const K = window.TASBruteCore, I = window.TASInputs, W = window.TASWindow;
  const bridge = window.tasBruteBridge;
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const fmtTime = (ms) => (ms / 1000).toFixed(3);
  const COLORS = { cp: '#ffd54a', fin: '#81c784', trigger: '#4fc3f7', nogo: '#ff5252', off: '#666' };

  let state = null;                 // the game's last 'state'
  let time = 0;                     // the replay's moment (ms)
  let running = false, haveResults = false, lastRate = null;
  const lines = new Map();          // result n → its line in the log

  // ================================================================ to the game
  // Each change is numbered (seq) and the game tells the last one it has (ack) in every state and brief.
  // A state written before it had them gets the newer changes put back over it, so nothing typed is undone.
  let seq = 0, settingsSeq = 0;
  const inflight = new Map();       // seq → the objective changes sent with it, until the game has them
  let objPending = new Map(), objTimer = 0;   // id → changes not sent yet (typing: sent 60 ms after the last key)
  function flushObj() {
    clearTimeout(objTimer); objTimer = 0;
    if (!objPending.size) return;
    const list = [...objPending.values()];
    objPending = new Map();
    inflight.set(++seq, list);
    if (bridge) bridge.send({ type: 'set', objectives: list, quiet: true, seq });
  }
  /** A message to the game. Changes still waiting go first, so everything arrives in the order it was done. */
  function send(msg) {
    flushObj();
    if (msg.type === 'set') {
      msg.seq = ++seq;
      if (msg.objectives) inflight.set(seq, msg.objectives);
      if (msg.settings) settingsSeq = seq;
    }
    if (bridge) bridge.send(msg);
  }
  /** A change to an objective, sent a moment later: { name: 'Gate' }, or one number of x, y, z: { c: [null, 12.5, null] }. */
  function queueObj(id, change) {
    const p = objPending.get(id) || { id };
    for (const k in change) {
      if (!Array.isArray(change[k])) { p[k] = change[k]; continue; }
      p[k] = p[k] || [null, null, null];
      change[k].forEach((v, i) => { if (v != null) p[k][i] = v; });
    }
    objPending.set(id, p);
    clearTimeout(objTimer);
    objTimer = setTimeout(flushObj, 60);
  }
  function applyChange(o, p) {
    for (const k of ['enabled', 'nogo', 'same']) if (p[k] != null) o[k] = !!p[k];
    if (p.name != null && String(p.name).trim()) o.name = String(p.name);
    for (const k of ['c', 'rot', 'size']) if (Array.isArray(p[k]) && Array.isArray(o[k])) p[k].forEach((v, i) => { if (v != null) o[k][i] = v; });
    if (o.nogo) o.same = false;
  }
  function acked(ack) { for (const s of [...inflight.keys()]) if (s <= ack) inflight.delete(s); }

  // ================================================================ settings
  const num = (id) => Number($(id).value);
  const TYPES = ['toggle', 'insert', 'shift'];
  const rows = $('inputRows');
  const field = (tr, t) => tr.querySelector('[data-t="' + t + '"]');
  function readSettings() {
    const inputs = [...rows.children].map((tr) => ({ keys: field(tr, 'keys').value.trim(), toggle: field(tr, 'toggle').checked, insert: field(tr, 'insert').checked, shift: field(tr, 'shift').checked, ranges: field(tr, 'ranges').value.trim() }));
    return {
      S: num('tS'), E: num('tE'), C: num('tC'),
      weights: { toggle: num('wToggle'), insert: num('wInsert'), shift: num('wShift') },
      insert: [num('insMin'), num('insMax')], shift: [num('shMin'), num('shMax')], per: [num('perMin'), num('perMax')],
      inputs, alpha: num('alpha'),
      scoreMode: (document.querySelector('input[name=scoreMode]:checked') || {}).value || 'check',
      speed: (document.querySelector('input[name=speedKind]:checked') || {}).value || 'raw',
      search: (document.querySelector('input[name=search]:checked') || {}).value || 'random',
      populations: num('pops'), iterations: num('iters'), threads: num('threads'),
      live: $('live').checked, showBoxes: $('showBoxes').checked,
    };
  }

  // ---- the inputs: one row each — the keys held together, the changes that may use them, and when
  function inputRow(r) {
    const tr = el('tr'), cell = (child, cls) => { const td = el('td', cls); td.append(child); return td; };
    const keys = el('input'); keys.type = 'text'; keys.dataset.t = 'keys'; keys.maxLength = 12; keys.spellcheck = false; keys.placeholder = 'wd';
    keys.title = 'Keys held together, written as in the input editor: wd is W and D, none is no keys';
    keys.value = r.keys || '';
    const ranges = el('input'); ranges.type = 'text'; ranges.dataset.t = 'ranges'; ranges.placeholder = 'whole window'; ranges.spellcheck = false;
    ranges.title = 'Where this input may be used, in ms (e.g. 2300-2500, 4100-4300); empty: the whole window';
    ranges.value = r.ranges || '';
    const del = el('button', 'icon', '✕'); del.title = 'Take this input off the list';
    del.addEventListener('click', () => { tr.remove(); settingsChanged(); });
    tr.append(cell(keys, 'k'));
    for (const t of TYPES) { const c = el('input'); c.type = 'checkbox'; c.dataset.t = t; c.checked = !!r[t]; c.addEventListener('change', settingsChanged); tr.append(cell(c)); }
    tr.append(cell(ranges, 'r'), cell(del));
    for (const e of [keys, ranges]) e.addEventListener('input', settingsChanged);
    return tr;
  }
  $('addInput').addEventListener('click', () => {
    const tr = inputRow({ keys: '', toggle: true, insert: true, shift: true, ranges: '' });
    rows.appendChild(tr);
    field(tr, 'keys').focus();
    settingsChanged();
  });

  /** The fields from the game's settings (never the one you are typing in). */
  function fillSettings(s) {
    const set = (id, v) => { const e = $(id); if (e !== document.activeElement && String(e.value) !== String(v)) e.value = v; };
    set('tS', s.S); set('tE', s.E); set('tC', s.C);
    set('wToggle', s.weights.toggle); set('wInsert', s.weights.insert); set('wShift', s.weights.shift);
    set('insMin', s.insert[0]); set('insMax', s.insert[1]); set('shMin', s.shift[0]); set('shMax', s.shift[1]);
    set('perMin', s.per[0]); set('perMax', s.per[1]);
    const list = s.inputs || [];
    if (rows.children.length !== list.length) { rows.textContent = ''; for (const r of list) rows.appendChild(inputRow(r)); }
    else list.forEach((r, j) => {
      const tr = rows.children[j];
      for (const t of ['keys', 'ranges']) { const e = field(tr, t); if (e !== document.activeElement && e.value !== (r[t] || '')) e.value = r[t] || ''; }
      for (const t of TYPES) field(tr, t).checked = !!r[t];
    });
    set('alpha', s.alpha);
    for (const r of document.querySelectorAll('input[name=scoreMode]')) r.checked = r.value === s.scoreMode;
    for (const r of document.querySelectorAll('input[name=speedKind]')) r.checked = r.value === (s.speed || 'raw');
    for (const r of document.querySelectorAll('input[name=search]')) r.checked = r.value === s.search;
    set('pops', s.populations); set('iters', s.iterations); set('threads', s.threads);
    $('live').checked = !!s.live; $('showBoxes').checked = !!s.showBoxes;
    hints();
  }

  let settingsTimer = 0;
  function settingsChanged() {
    hints();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(sendSettings, 120);
  }
  function sendSettings() { clearTimeout(settingsTimer); settingsTimer = 0; send({ type: 'set', settings: readSettings(), quiet: true }); }

  /** The lines under the fields: what the time window means, the slider, the search's size. */
  function hints() {
    const s = readSettings();
    const th = $('timeHint');
    if (!(s.E >= s.S)) { th.textContent = 'End has to be at or after Start.'; th.className = 'hint bad'; }
    else {
      th.className = 'hint';
      th.textContent = 'Changes from ' + fmtTime(s.S) + ' to ' + fmtTime(s.E) + ' s (' + fmtInt(s.E - s.S + 1) + ' ms), scored at ' + fmtTime(Math.max(s.C, s.E + 1)) + ' s'
        + (s.C <= s.E ? ' (check moves to 1 ms after End)' : '') + '. Replay at ' + fmtTime(time) + ' s.';
    }
    const a = s.alpha, ah = $('alphaHint');
    ah.textContent = a <= 0 ? '100 % distance: the closest to the next objective, or the earliest at the last one.'
      : a >= 100 ? '100 % speed: the fastest (objectives reached still come first).'
        : (100 - a) + ' % distance · ' + a + ' % speed — 1 m is worth ' + (+((100 - a) / a).toFixed(3)) + ' km/h.';
    // the inputs: keys that do not read, one listed twice, times that do not read (checked as the game will)
    const seen = new Set();
    let problem = null;
    [...rows.children].forEach((tr, j) => {
      const kin = field(tr, 'keys'), rin = field(tr, 'ranges'), text = kin.value.trim();
      let bad = null;
      if (!text) bad = 'Input ' + (j + 1) + ' is empty: write keys like wd, or none.';
      else {
        const k = I.parseKeys(text);
        if (k.error) bad = '"' + text + '": ' + k.error + '.';
        else if (k.dup) bad = '"' + text + '" has a key twice.';
        else if (seen.has(k.bits)) bad = I.keysText(k.bits) + ' is in the list twice.';
        else seen.add(k.bits);
      }
      kin.classList.toggle('bad', !!bad);
      let rbad = null;
      try { K.parseRanges(rin.value); } catch (e) { rbad = e.message; }
      rin.classList.toggle('bad', !!rbad);
      problem = problem || bad || (rbad ? (text || 'Input ' + (j + 1)) + ': ' + rbad + '.' : null);
    });
    const ih = $('inputsHint');
    ih.textContent = problem || (rows.children.length ? 'A try only ever puts in inputs from this list (written as in the input editor: wd is W and D together, none is no keys).'
      : 'No inputs yet: add the keys a try may hold together, like wd.');
    ih.className = 'hint grow' + (problem || !rows.children.length ? ' bad' : '');
    // Iterations is the random search's: the exhaustive one goes until every pattern is tried or you stop it
    const exh = s.search === 'exhaustive';
    for (const e of document.querySelectorAll('.r-only')) e.classList.toggle('hidden', exh);
    $('threads').title = 'Physics workers at once (0: ' + ((state && state.threadsAuto) || 'auto') + ', from this computer\'s cores)';
    const sh = $('searchHint');
    sh.className = 'hint';
    const auto = (state && state.threadsAuto) || 1, T = s.threads || auto;
    if (exh) {
      const x = state && state.exhaustive;
      if (!x || x.error) { sh.textContent = x && x.error ? x.error : ''; sh.className = 'hint bad'; }
      else if (x.total <= 1) { sh.textContent = 'Nothing to try: list an input that differs from the run, with times inside the window.'; sh.className = 'hint bad'; }
      else {
        let t = patterns(x.total, x.bits) + ' (' + fmtInt(x.ticks) + ' ms that can change, up to ' + x.most + ' choices at each)';
        // the last run's speed, per thread, times the threads this one would have
        if (lastRate) t += ' · ' + allTaking(x, lastRate.rate / lastRate.threads * Math.min(T, x.total)) + ' at the last speed';
        sh.textContent = t + '. Threads: ' + T + (s.threads ? '' : ' (auto)') + '. It goes until they are all tried or you stop it.';
      }
    } else sh.textContent = s.populations + (s.populations === 1 ? ' population' : ' populations') + ' on ' + T + ' thread' + (T === 1 ? '' : 's') + (s.threads ? '' : ' (auto)')
      + ' · ' + (s.iterations > 0 ? fmtInt(s.iterations) + ' tries each' : 'until you stop it') + '.';
  }
  const duration = (sec) => (sec < 90 ? Math.max(1, Math.round(sec)) + ' s' : sec < 5400 ? Math.round(sec / 60) + ' min' : sec < 172800 ? (sec / 3600).toFixed(1) + ' h'
    : sec < 63072000 ? Math.round(sec / 86400) + ' days' : fmtInt(sec / 31557600) + ' years');
  /** A count of patterns: in full, or as a power of 2 when it is past what a number writes exactly. */
  const count = (total, bits) => (total > 1e15 ? 'about 2^' + Math.round(bits) : fmtInt(total));
  const patterns = (total, bits) => count(total, bits) + (total === 1 ? ' pattern' : ' patterns');
  /** How long all of them would take at `perSec` (past a million years, as a power of ten). */
  function allTaking(x, perSec) {
    const sec = x.total / perSec;
    if (sec < 3.15576e13) return 'about ' + duration(sec);
    return 'about 10^' + Math.floor(x.bits * Math.log10(2) - Math.log10(perSec * 31557600)) + ' years';
  }

  for (const e of document.querySelectorAll('.section-settings input, #live, #showBoxes')) {
    e.addEventListener('input', settingsChanged);
    e.addEventListener('change', settingsChanged);
  }
  for (const b of document.querySelectorAll('button.now')) b.addEventListener('click', () => { $(b.dataset.for).value = time; settingsChanged(); });

  // number fields: the wheel steps them (Shift ×10, Ctrl ×0.1), without having to click in first
  function wheelStep(input, after) {
    input.addEventListener('wheel', (ev) => {
      if (input.disabled) return;
      const d = ev.deltaY || ev.deltaX;               // with Shift held, Windows turns the wheel sideways
      const now = input.value === '' ? NaN : Number(input.value);
      if (!d || !isFinite(now)) return;               // half typed: no number to step from
      ev.preventDefault();
      const step = Number(input.step) || 1, mul = ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1;
      let v = now + (d < 0 ? 1 : -1) * step * mul;
      if (input.min !== '' && v < Number(input.min)) v = Number(input.min);
      if (input.max !== '' && v > Number(input.max)) v = Number(input.max);
      const dec = Math.max(0, (String(step).split('.')[1] || '').length + (ev.ctrlKey ? 1 : 0));
      input.value = Number(v.toFixed(Math.min(6, dec)));
      after();
    }, { passive: false });
  }
  for (const e of document.querySelectorAll('.section-settings input[type=number]')) wheelStep(e, settingsChanged);

  // ================================================================ objectives
  // The list and the editor are built again only when what they show changes shape (another objective
  // picked; one added, removed, moved, left out, made a no-go). Otherwise their values change in place,
  // never in the field being typed in: a field keeps the keyboard, and a click never lands on a rebuild.
  const byId = (id) => (state ? state.objectives.find((o) => o.id === id) : null);
  const selectedObj = () => byId(state && state.selected);
  const labelOf = (o) => (o.kind === 'box' ? o.name || (o.nogo ? 'No-go' : 'Trigger') : o.label);
  function colorOf(o) { return !o.enabled ? COLORS.off : o.kind === 'cp' ? COLORS.cp : o.kind === 'fin' ? COLORS.fin : o.nogo ? COLORS.nogo : COLORS.trigger; }
  function renderObjectives() { renderList(); syncEditor(); }

  let listKey = null;
  function renderList() {
    const list = $('objList');
    if (!state) { list.textContent = ''; listKey = null; return; }
    const order = new Map();
    state.groups.forEach((g, i) => { for (const id of g.ids) order.set(id, i + 1); });
    const key = JSON.stringify([state.selected, state.objectives.map((o) => [o.id, labelOf(o), !!o.enabled, !!o.nogo, !!o.same, order.get(o.id) || 0])]);
    if (key === listKey) return;
    listKey = key;
    list.textContent = '';
    state.objectives.forEach((o, i) => {
      const id = o.id;
      const row = el('div', 'obj-item' + (id === state.selected ? ' sel' : '') + (o.enabled ? '' : ' off'));
      row.dataset.id = id;
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!o.enabled;
      cb.title = o.enabled ? 'In use: click to leave it out' : 'Left out: click to use it';
      cb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const x = byId(id); if (x) x.enabled = cb.checked;
        send({ type: 'set', objectives: [{ id, enabled: cb.checked }] });
        renderList();
      });
      const dot = el('span', 'obj-color'); dot.style.background = colorOf(o);
      const ord = el('span', 'obj-order', o.kind === 'box' && o.nogo ? '✕' : order.has(id) ? String(order.get(id)) : '–');
      ord.title = o.kind === 'box' && o.nogo ? 'A no-go: stay out of it' : order.has(id) ? 'Its place in the order' + (o.same ? ' (or the one above)' : '') : 'Not in use';
      const name = el('span', 'obj-name', (o.same && !o.nogo ? 'or ' : '') + labelOf(o));
      const icons = el('span', 'icons');
      const up = el('button', 'icon', '▲'), down = el('button', 'icon', '▼');
      up.title = 'Earlier in the order'; down.title = 'Later in the order';
      const builtinAt = (j) => state.objectives[j] && state.objectives[j].kind !== 'box';
      up.disabled = i === 0 || (o.kind !== 'box' && builtinAt(i - 1));
      down.disabled = i === state.objectives.length - 1 || (o.kind !== 'box' && builtinAt(i + 1));
      up.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'move', id, dir: -1 }); });
      down.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'move', id, dir: 1 }); });
      icons.append(up, down);
      row.append(cb, dot, ord, name, icons);
      row.addEventListener('click', () => { if (!state) return; state.selected = id; send({ type: 'select', id }); renderObjectives(); });
      list.appendChild(row);
    });
  }

  let editKey = null, refreshEditor = null;
  /** The picked objective's editor: built when another one is picked (or it turns trigger / no-go), else refreshed. */
  function syncEditor() {
    const box = $('objEdit'), o = selectedObj();
    const key = !o ? '' : o.kind === 'box' ? o.id + (o.nogo ? ':nogo' : ':trigger') : o.id + ':' + JSON.stringify([state.track.shared, state.track.finishes]);
    if (key === editKey) { if (refreshEditor) refreshEditor(); return; }
    editKey = key; refreshEditor = null;
    box.textContent = '';
    if (!o) return;
    if (o.kind !== 'box') {
      const n = o.kind === 'cp' ? state.track.shared[o.k] : state.track.finishes;
      box.appendChild(el('div', 'about', o.kind === 'cp'
        ? 'Checkpoint ' + (o.k + 1) + ': the game\'s own' + (n > 1 ? ', ' + n + ' gates (reaching any one counts, the nearest is aimed for)' : '') + '. It counts when the game registers it.'
        : 'The finish' + (n > 1 ? ' (' + n + ' lines: any one counts)' : '') + '. It counts when the game registers it.'));
      box.appendChild(el('div', 'about dim', 'It keeps its place among the checkpoints and the finish; trigger boxes can go anywhere around it. Its hitbox shows in yellow (green: the finish) while this window is open.'));
      return;
    }
    const id = o.id, cur = () => byId(id);
    const bound = [];                 // [element, its value now, a checkbox?]: shown again when the game says otherwise
    const nameRow = el('div', 'row');
    const nameIn = el('input'); nameIn.type = 'text'; nameIn.maxLength = 40; nameIn.spellcheck = false;
    nameIn.addEventListener('input', () => {
      const x = cur();
      if (!x || !nameIn.value.trim()) return;           // emptied: it keeps its name
      x.name = nameIn.value;
      queueObj(id, { name: nameIn.value });
      renderList();
    });
    nameIn.addEventListener('blur', () => { const x = cur(); if (x) nameIn.value = x.name || ''; });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { flushObj(); nameIn.select(); } });
    bound.push([nameIn, () => cur().name || '']);
    nameRow.append(nameIn);
    box.appendChild(nameRow);
    const kind = el('div', 'row');
    const mk = (label, nogo) => {
      const l = el('label', 'check'), r = el('input'); r.type = 'radio'; r.name = 'objKind'; r.checked = !!o.nogo === nogo;
      r.addEventListener('change', () => {
        const x = cur(); if (!x) return;
        x.nogo = nogo; if (nogo) x.same = false;
        send({ type: 'set', objectives: [{ id, nogo, same: !!x.same }] });
        renderObjectives();
      });
      l.append(r, ' ' + label); return l;
    };
    kind.append(mk('Trigger', false), mk('No-go', true));
    box.appendChild(kind);
    let same = null;
    if (!o.nogo) {
      const l = el('label', 'check');
      same = el('input'); same.type = 'checkbox';
      same.addEventListener('change', () => { const x = cur(); if (x) x.same = same.checked; send({ type: 'set', objectives: [{ id, same: same.checked }] }); renderList(); });
      l.append(same, ' Same order as the one above (either counts)');
      box.appendChild(l);
      bound.push([same, () => !!cur().same, true]);
    }
    const xyz = el('div', 'xyz');
    xyz.append(el('span'), el('span', null, 'x'), el('span', null, 'y'), el('span', null, 'z'));
    const field = (prop, i, step, min) => {
      const inp = el('input'); inp.type = 'number'; inp.step = step;
      if (min != null) inp.min = min;
      const typed = () => { const s = inp.value.trim(); if (s === '' || inp.validity.badInput) return null; const v = Number(s); return isFinite(v) ? v : null; };
      const upd = () => {
        const x = cur(), v0 = typed();
        if (!x || v0 == null) return;                   // half typed ("-", "2e"): not a number yet
        const v = prop === 'size' ? Math.max(0.05, Math.abs(v0)) : v0;
        x[prop][i] = v;
        const change = [null, null, null]; change[i] = v;
        queueObj(id, { [prop]: change });
      };
      inp.addEventListener('input', upd);
      inp.addEventListener('blur', () => { const x = cur(); if (x) inp.value = x[prop][i]; });   // left half typed or empty: what it is
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { flushObj(); inp.select(); } });
      wheelStep(inp, upd);
      bound.push([inp, () => cur()[prop][i]]);
      return inp;
    };
    const rowOf = (label, prop, step, min, names) => {
      const l = el('label', null, label); if (names) l.title = names;
      xyz.append(l, field(prop, 0, step, min), field(prop, 1, step, min), field(prop, 2, step, min));
    };
    rowOf('Position', 'c', '0.1');
    rowOf('Turn °', 'rot', '1', null, 'yaw (about up), pitch, roll — in degrees');
    rowOf('Size', 'size', '0.1', '0.05');
    box.appendChild(xyz);
    box.appendChild(el('div', 'hint', 'Turn: yaw, pitch, roll. Size: width, height, depth (metres). The wheel changes a number (Shift ×10, Ctrl ×0.1). Delete removes the picked box.'));
    const btns = el('div', 'row');
    const put = el('button', 'small', 'Put at car'), turn = el('button', 'small', 'Turn to car'), del = el('button', 'small', 'Delete');
    put.title = 'Move it to where the car is at the replay\'s moment, facing the way it drives';
    turn.title = 'Keep it where it is, turned the way the car drives at the replay\'s moment';
    del.title = 'Remove it (the Delete key does too)';
    put.addEventListener('click', () => send({ type: 'place', id }));
    turn.addEventListener('click', () => send({ type: 'place', id, turnOnly: true }));
    del.addEventListener('click', () => send({ type: 'remove', id }));
    btns.append(put, turn, el('span', 'grow'), del);
    box.appendChild(btns);
    refreshEditor = () => {
      const x = cur();
      if (!x) return;
      for (const [e, get, check] of bound) {
        if (e === document.activeElement) continue;     // never under the hands
        const v = get();
        if (check) e.checked = v; else if (e.value !== String(v)) e.value = v;
      }
      if (same) same.disabled = state.objectives.indexOf(x) === 0;
    };
    refreshEditor();
  }

  $('addTrigger').addEventListener('click', () => send({ type: 'add', nogo: false }));
  $('addNogo').addEventListener('click', () => send({ type: 'add', nogo: true }));

  // ================================================================ the run and its output
  function setRunning(on) {
    running = on;
    $('start').disabled = on || !state;
    $('stop').disabled = !on;
    $('useBest').disabled = !haveResults;
  }
  $('start').addEventListener('click', () => { sendSettings(); send({ type: 'start' }); });
  $('stop').addEventListener('click', () => send({ type: 'stop' }));
  $('useBest').addEventListener('click', () => send({ type: 'apply', n: 'best' }));

  const log = $('log');
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  function addInfo(text, cls) {
    const stick = atBottom();
    log.appendChild(el('div', cls || 'info', text));
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function addResult(r) {
    const stick = atBottom();
    const who = r.start ? 'Start' : 'P' + (r.pop + 1);
    const tail = r.start ? '' : '   after ' + fmtInt(r.tries) + (r.tries === 1 ? ' try' : ' tries') + ' · ' + (r.at / 1000).toFixed(1) + ' s';
    const d = el('div', r.start ? 'start' : !r.clean ? 'nogo' : r.overall ? 'gold' : '', who.padEnd(6) + r.text + tail);
    d.title = r.start ? 'Click: the inputs the bruteforce started from, back on the car' : 'Click: these inputs on the car' + (r.overall ? ' (an overall best)' : '');
    d.dataset.n = r.n;
    d.addEventListener('click', () => send({ type: 'apply', n: r.n }));
    lines.set(r.n, d);
    log.appendChild(d);
    haveResults = true;
    $('useBest').disabled = false;
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function markVerify(v) {
    for (const d of lines.values()) { const c = d.querySelector('.chk'); if (c) c.remove(); }
    const d = lines.get(v.n);
    if (!d) return;
    const c = el('span', 'chk' + (v.pending ? ' wait' : v.ok ? '' : ' no'), v.pending ? 'checking…' : v.ok ? '✓ the same in the game' : '✗ ' + (v.detail || 'different in the game'));
    c.title = v.pending ? 'The Replay Editor is running these inputs from the start' : v.ok ? 'The Replay Editor\'s own run of these inputs, from the start, scores exactly the same' : 'Please report this: the result did not replay the same';
    d.appendChild(c);
  }
  function showProgress(r) {
    if (!r) { $('progress').textContent = ''; return; }
    let t = fmtInt(r.tries) + ' tries · ' + fmtInt(r.rate) + '/s · ' + r.msPerTry.toFixed(2) + ' ms a try';
    if (r.total > 1e15) t += ' · of ' + patterns(r.total, r.bits);
    else if (r.total) t += ' · ' + (100 * r.tries / r.total).toFixed(r.tries / r.total < 0.1 ? 2 : 1) + ' % of ' + fmtInt(r.total);
    if (r.repeats) t += ' · ' + fmtInt(r.repeats) + ' repeats skipped';
    $('progress').textContent = t;
    if (r.tries > 50 && r.threads > 0) lastRate = { rate: r.rate, threads: r.threads };
  }

  // keys, while the bruteforce is the part in use: Ctrl+Enter starts, Delete removes the picked trigger box
  // (not while typing in a field); Escape stops a run whenever the bruteforce shows (and nothing else is open)
  window.addEventListener('keydown', (e) => {
    const t = e.target, typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|number|search)$/.test(t.type)));
    const overlay = document.querySelector('.overlay:not(.hidden)');
    if (e.key === 'Escape' && running && !overlay && (!W || W.shows('brute'))) { e.preventDefault(); $('stop').click(); return; }
    if (W && !W.active('brute')) return;
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (!running) $('start').click(); }
    else if (e.key === 'Delete' && !typing && !e.repeat) {
      const o = selectedObj();
      if (o && o.kind === 'box') { e.preventDefault(); send({ type: 'remove', id: o.id }); }
    }
  });
  // the game shows the checkpoints' hitboxes, the car's and the time bar's mark while this part shows
  if (W) W.onView(() => send({ type: 'shown', on: W.shows('brute') }));

  // ================================================================ the game
  function onState(msg) {
    acked(msg.ack || 0);
    state = msg;
    // changes the game did not have yet when it wrote this, over it
    for (const list of inflight.values()) for (const p of list) { const o = byId(p.id); if (o) applyChange(o, p); }
    for (const p of objPending.values()) { const o = byId(p.id); if (o) applyChange(o, p); }
    if (W) W.detached('brute', false);
    $('runNote').textContent = msg.runCar === -1 ? 'The run\'s car is not in this Replay Editor' : msg.runCar != null && msg.runCar !== msg.car.index ? 'The run is on another car' : '';
    if (!settingsTimer && (msg.ack || 0) >= settingsSeq) fillSettings(msg.settings);
    else hints();
    renderObjectives();
    setRunning(!!(msg.run && msg.run.running));
    showProgress(msg.run);
  }

  if (bridge) bridge.onMessage((msg) => {
    switch (msg.type) {
      case 'state': onState(msg); break;
      case 'brief': acked(msg.ack || 0); if (state) { state.groups = msg.groups; state.exhaustive = msg.exhaustive; renderObjectives(); hints(); } break;
      case 'time': time = msg.t; hints(); break;
      case 'added': if (state) state.selected = msg.id; break;
      case 'results':
        log.textContent = ''; lines.clear(); haveResults = false;
        for (const r of msg.lines) addResult(r);
        if (msg.verify) markVerify(msg.verify);
        break;
      case 'started':
        log.textContent = ''; lines.clear(); haveResults = false;
        addInfo('Started on ' + msg.carName + ': changes from ' + fmtTime(msg.S) + ' to ' + fmtTime(msg.E) + ' s, scored at ' + fmtTime(msg.C) + ' s'
          + (msg.speed === 'signed' ? ' (signed speed)' : '') + ' — '
          + (msg.search === 'exhaustive' ? 'every pattern (' + count(msg.total, msg.bits) + ')' : msg.pops + (msg.pops === 1 ? ' population' : ' populations')) + ' on ' + msg.threads + (msg.threads === 1 ? ' thread' : ' threads'));
        setRunning(true);
        break;
      case 'result': addResult(msg.line); break;
      case 'progress': showProgress(msg.run); break;
      case 'finished':
        setRunning(false);
        showProgress(msg.run);
        addInfo((msg.complete ? 'Done' : 'Stopped') + ' after ' + fmtInt(msg.run.tries) + ' tries in ' + (msg.run.elapsed / 1000).toFixed(1) + ' s (' + fmtInt(msg.run.rate) + ' a second).');
        hints();
        break;
      case 'verify': markVerify(msg); break;
      case 'log': addInfo(msg.text, msg.cls === 'bad' ? 'bad' : 'info'); break;
      case 'detached':
        state = null; inflight.clear(); objPending = new Map(); clearTimeout(objTimer);
        if (W) W.detached('brute', true);
        $('runNote').textContent = ''; setRunning(false); renderObjectives();
        break;
    }
  });
  setRunning(false);
  hints();
  send({ type: 'hello' });
  send({ type: 'shown', on: !W || W.shows('brute') });
  window.TASBruteWindow = { get state() { return state; }, readSettings, send, lines, log };
})();
