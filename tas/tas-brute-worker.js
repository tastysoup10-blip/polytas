/*
 * PolyTrack TAS — the bruteforce inside a physics worker. Not loaded on its own: tools/patches.mjs puts it into
 * the game's simulation worker after the lane code (it uses the same names: t the physics module, e its cars,
 * i where a frame's state is written), with tas-brute-core.js and tas-brute-physics.js before it.
 *
 * One car in the worker. It drives the run's own inputs up to the start time and keeps a copy of the whole
 * physics memory there. The worker's physics is polytrack_physics_tas.wasm: the game's own, which also notes
 * every 4 KB page of memory it writes (tools/wasm-marks.mjs). So after a try the memory is put back exactly by
 * copying back only the pages it wrote, and the population's best is kept at moments through the window
 * ("saved states"): a try starts at the last one before its first change, since every frame before it would only
 * repeat what the best did. Each try is scored (tas-brute-core.js); one that beats its population's best is run
 * again from a full copy of the memory, with saved states of its own, and that run's score is the one reported.
 */
function __tasBruteMsg(m) {
  const S0 = __tasS(), K = self.TASBruteCore;
  if ('brute-stop' === m.__tas) { if (S0.B) { S0.B.stopped = !0; postMessage({ __tas: 'brute-stopped', id: S0.B.id }); } return; }
  if ('brute-best' === m.__tas) {
    const B = S0.B, p = B && B.pops.find((x) => x.id === m.pop);
    if (p && K.better(m.score, p.score)) { __tasBruteDrop(B, p); p.win = new Uint8Array(m.win); p.score = m.score; }
    return;
  }
  if ('brute' !== m.__tas) return;
  const c = e.find((x) => x.id === m.carId);
  if (null == c) throw new Error('no car ' + m.carId);
  const P = self.__tasPhys;
  if (!P) { postMessage({ __tas: 'brute-error', id: m.id, message: 'the bruteforce\'s physics did not load' + (self.__tasPhysError ? ' (' + self.__tasPhysError + ')' : '') }); return; }
  const t0 = performance.now();
  for (const g of m.groups) for (const mb of g.members) { if (mb.box) K.fixBox(mb.box); if (mb.boxes) mb.boxes.forEach(K.fixBox); }
  for (const ng of m.nogos) K.fixBox(ng.box);
  (m.cpBoxes || []).forEach((l) => l.forEach(K.fixBox));
  (m.finBoxes || []).forEach(K.fixBox);
  const S = m.S, E = m.E, C = m.C;
  const B = {
    id: m.id, car: c, S, E, C, base: m.base, stopped: !1, dv: null,
    win0: K.statesOf(m.base, S, E), tail: K.statesOf(m.base, E + 1, C - 1),
    ctx: K.mutationContext({ inputs: m.inputs, S, E, changes: m.base, weights: m.weights, insert: m.insert, shift: m.shift, per: m.per }),
    tracker: new K.Tracker({ groups: m.groups, nogos: m.nogos, S, C, alpha: m.alpha, mode: m.scoreMode, vref: 0, speed: m.speed, cpBoxes: m.cpBoxes, finBoxes: m.finBoxes }),
    search: m.search, rng: K.rng(m.seed >>> 0), seen: m.search === 'random' ? new Float64Array(1 << 19) : null, repeats: 0, idle: 0,
    tries: 0, frames: 0, skipped: 0, keeps: 0, busy: 0, restore: 0, lastReport: 0, port: null, scratch: null,
    marks: new Uint8Array(P.tasmarks.buffer), marks32: new Uint32Array(P.tasmarks.buffer), sp: P.tassp, sp0: 0,
    state: null, gen: 0, cap: 0, tgt: null, slot: null, done: null, pool: [], fulls: 0, traps: 0, lastTrap: null, mismatches: 0,
    check: !!m.check, checked: 0, badPages: 0,
  };
  B.scratch = new Uint8Array(B.win0.length);
  // the run's own inputs up to the start time (no-gos before it do not count)
  const tr = B.tracker;
  tr.reset();
  tr.begin(m.start.p[0], m.start.p[1], m.start.p[2], m.start.q[0], m.start.q[1], m.start.q[2], m.start.q[3], 0);
  const ctl = __tasControls(m.channels);
  for (let f = 0; f < S; f++) {
    const k = ctl.getControls(f);
    t._updateCarModel(c.id, k.up, k.right, k.down, k.left, k.reset, i);
    __tasBruteRead(B, f + 1, !1);
  }
  B.snap = t.HEAPU8.slice();
  B.basePages = B.snap.length >> 12;
  B.marks.fill(0);
  self.__tasJsTouched = !1;
  B.sp0 = B.sp.value;
  B.s0 = tr.save();
  // saved states: up to 32 through the window, at least 16 ms apart (more populations on this thread: fewer)
  const per = Math.max(1, m.pops.length);
  B.every = Math.max(16, Math.ceil((E - S + 1) / Math.max(4, Math.floor(32 / Math.min(4, per)))));
  // the run itself, kept: its score, and the speed the distance is converted at (vref: where it reached the last objective, or at the check time)
  const own = __tasBruteKeep(B, B.win0, m.search !== 'exhaustive');
  const n = m.groups.length;
  tr.cfg.vref = Math.max(10, n > 0 && own.score.hits === n ? own.score.speeds[n - 1] : own.score.V);
  const base = tr.result();
  B.baseSnaps = own.snaps || [];
  B.pops = m.pops.map((p) => ({ id: p.id, win: B.win0.slice(), score: base, snaps: B.baseSnaps, budget: p.budget, tries: 0 }));
  if (B.search === 'exhaustive') {
    // this worker's patterns: one block of them [from, to), in order (neighbours share everything but their last ticks);
    // BigInts, so a block can be any size, and the next pattern comes from the last one's digits
    B.vars = K.exhaustiveVariables(B.ctx, B.win0);
    const c = K.patternCount(B.vars), from = BigInt(m.from), to = BigInt(m.to) < c.big ? BigInt(m.to) : c.big;
    B.total = c.total; B.left = to > from ? to - from : 0n; B.k = 0;
    B.digits = K.patternDigits(B.vars, from, new Int32Array(B.vars.length));
    B.at = new Array(B.vars.length).fill(null); B.atOk = 0;     // the saved state at each variable's tick, good for the first atOk
    // saved states only at the last 32 variables (memory stays bounded however long the window): one before them
    // changes once in 2^32 patterns or more, and that try starts at the start time
    B.keepFrom = Math.max(0, B.vars.length - 32);
  }
  S0.B = B;
  postMessage({ __tas: 'brute-ready', id: m.id, base, vref: tr.cfg.vref, before: B.s0.g, ms: performance.now() - t0, heap: t.HEAPU8.length,
    vars: B.vars ? B.vars.length : null, total: B.total || null, every: B.every, saved: B.baseSnaps.length });
  const ch = new MessageChannel();
  ch.port1.onmessage = __tasBruteSlice;
  B.port = ch.port2;
  B.port.postMessage(0);
}

/** Frame f's state, from where the physics wrote it, into the tracker (returns true when the try is over). */
function __tasBruteRead(B, f, live) {
  const h = t.HEAPU8;
  let dv = B.dv;
  if (null == dv || dv.buffer !== h.buffer) dv = B.dv = new DataView(h.buffer);
  const o = i + 4, v = dv.getFloat32(o + 3, !0), fl = h[o + 7];
  let p = o + 8 + (2 & fl ? 3 : 0);
  const nci = dv.getUint16(p, !0);
  p += 2;
  return B.tracker.frame(f, dv.getFloat32(p, !0), dv.getFloat32(p + 4, !0), dv.getFloat32(p + 8, !0),
    dv.getFloat32(p + 12, !0), dv.getFloat32(p + 16, !0), dv.getFloat32(p + 20, !0), dv.getFloat32(p + 24, !0), v, nci, 0 != (2 & fl), live);
}

/*
 * Putting the memory back. A saved state is the pages that differ from the start time (with their contents);
 * the start time itself is the full copy. To go from what the last try left to a state `to`: every page written
 * since the last time (and the page after each), every page the last state had of its own, and every page `to`
 * has of its own get `to`'s contents — its own page, or else the start time's (zeros past it: memory added since
 * is zero). `full`: all of the memory, whatever the marks say; and always when something wrote memory without
 * marks (the physics' own JavaScript, tas-brute-physics.js) or a try left the stack pointer elsewhere (a trap).
 */
function __tasBruteRestore(B, to, full) {
  const r0 = performance.now(), h = t.HEAPU8, snap = B.snap, marks = B.marks, n = h.length >> 12;
  if (full || self.__tasJsTouched || B.sp.value !== B.sp0) {
    if (!full) B.fulls++;
    B.sp.value = B.sp0; self.__tasJsTouched = !1;
    h.set(snap);
    if (h.length > snap.length) h.fill(0, snap.length);
    marks.fill(0);
    if (to) for (let k = 0; k < to.pages.length; k++) h.set(to.data.subarray(k << 12, (k + 1) << 12), to.pages[k] << 12);
  } else {
    const G = __tasBruteGen(B, n), tgt = B.tgt, slot = B.slot, done = B.done, bp = B.basePages, prev = B.state;
    if (to) for (let k = 0; k < to.pages.length; k++) { tgt[to.pages[k]] = G; slot[to.pages[k]] = k; }
    const put = (q) => {
      if (q >= n || done[q] === G) return;
      done[q] = G;
      const o = q << 12;
      if (tgt[q] === G) { const s = slot[q] << 12; h.set(to.data.subarray(s, s + 4096), o); }
      else if (q < bp) h.set(snap.subarray(o, o + 4096), o);
      else h.fill(0, o, o + 4096);
    };
    const m32 = B.marks32, words = (n + 3) >> 2;
    for (let w = 0; w < words; w++) {
      const v = m32[w];
      if (0 === v) continue;
      m32[w] = 0;
      const q = w << 2;                                       // four pages a word, the first in the low byte
      if (v & 0xff) { put(q); put(q + 1); }
      if (v & 0xff00) { put(q + 1); put(q + 2); }
      if (v & 0xff0000) { put(q + 2); put(q + 3); }
      if (v & 0xff000000) { put(q + 3); put(q + 4); }
    }
    if (prev && prev !== to) for (let k = 0; k < prev.pages.length; k++) put(prev.pages[k]);
    if (to && to !== prev) for (let k = 0; k < to.pages.length; k++) put(to.pages[k]);
  }
  B.state = to;
  B.restore += performance.now() - r0;
  if (B.check) __tasBruteVerify(B, to);
}

/** A new mark for the per-page tables (tgt, slot, done), made big enough for n pages: a page holds the mark when it is in this round's set. */
function __tasBruteGen(B, n) {
  if (n + 2 > B.cap) { B.cap = n + 256; B.tgt = new Int32Array(B.cap); B.slot = new Int32Array(B.cap); B.done = new Int32Array(B.cap); B.gen = 0; }
  if (++B.gen > 1e9) { B.gen = 1; B.tgt.fill(0); B.done.fill(0); }
  return B.gen;
}

/** Tests only (m.check): the whole memory against what `to` should be, page by page. */
function __tasBruteVerify(B, to) {
  const h = t.HEAPU8, n = h.length >> 12, snap = B.snap, mine = new Map();
  if (to) for (let k = 0; k < to.pages.length; k++) mine.set(to.pages[k], k);
  const a = new Int32Array(h.buffer, 0, h.length >> 2), b = new Int32Array(snap.buffer, 0, snap.length >> 2);
  for (let q = 0; q < n; q++) {
    const o = q << 10, k = mine.get(q);
    const want = k != null ? new Int32Array(to.data.buffer, to.data.byteOffset + (k << 12), 1024) : null;
    for (let j = 0; j < 1024; j++) {
      const x = a[o + j], y = want ? want[j] : q < B.basePages ? b[o + j] : 0;
      if (x !== y) { B.badPages++; break; }
    }
  }
  B.checked++;
}

/** A buffer for a saved state's pages (from the ones given back, when one is big enough). */
function __tasBruteBuf(B, bytes) {
  for (let j = 0; j < B.pool.length; j++) { const b = B.pool[j]; if (b.length >= bytes && b.length <= 2 * bytes) { B.pool.splice(j, 1); return b; } }
  return new Uint8Array(Math.ceil(bytes / 65536) * 65536);
}
function __tasBruteRelease(B, snaps) { if (snaps && snaps !== B.baseSnaps) for (const s of snaps) if (B.pool.length < 64) B.pool.push(s.data); }
/** A population's saved states no longer fit its best (another one replaced it): given back, kept again when next needed. */
function __tasBruteDrop(B, p) { __tasBruteRelease(B, p.snaps); p.snaps = null; }

/**
 * A saved state at frame f: the pages that differ from the start time — those of the state the memory was put
 * back to, and those written since (and the page after each) — with their contents, and the score so far.
 */
function __tasBruteTake(B, f) {
  const h = t.HEAPU8, marks = B.marks, n = h.length >> 12, list = [], own = B.state, G = __tasBruteGen(B, n), mine = B.done;
  if (own) for (let k = 0; k < own.pages.length; k++) mine[own.pages[k]] = G;
  for (let q = 0; q < n; q++) if (mine[q] === G || marks[q] || (q > 0 && marks[q - 1])) list.push(q);
  const pages = Int32Array.from(list), data = __tasBruteBuf(B, pages.length << 12);
  for (let k = 0; k < pages.length; k++) { const o = pages[k] << 12; data.set(h.subarray(o, o + 4096), k << 12); }
  return { f, pages, data, tr: B.tracker.save() };
}

/**
 * A window run from a full copy of the memory at the start time (exact whatever the marks say), saving its
 * state every B.every frames inside the window when `save`: its score and its saved states.
 */
function __tasBruteKeep(B, win, save) {
  __tasBruteRestore(B, null, !0);
  const tr = B.tracker, snaps = save ? [] : null;
  tr.load(B.s0);
  const id = B.car.id, S = B.S, E = B.E, C = B.C, tail = B.tail, every = B.every;
  let f = S, next = S + every;
  try {
    while (f < C) {
      if (snaps && f === next && f <= E) { snaps.push(__tasBruteTake(B, f)); next += every; }
      const k = f <= E ? win[f - S] : tail[f - E - 1];
      t._updateCarModel(id, 0 != (1 & k), 0 != (8 & k), 0 != (4 & k), 0 != (2 & k), 0 != (16 & k), i);
      f++;
      if (__tasBruteRead(B, f, !0)) break;
    }
  } catch (x) { B.frames += f - S; __tasBruteRelease(B, snaps); return { score: __tasBruteTrap(B, x), snaps: null }; }
  B.frames += f - S; B.keeps++;
  // the physics' own JavaScript wrote memory on the way: these states could miss a page
  if (self.__tasJsTouched) { __tasBruteRelease(B, snaps); return { score: tr.result(), snaps: null }; }
  return { score: tr.result(), snaps };
}

/** One try: from a saved state (null: the start time), the try's keys inside the window and the run's own after it, to the check time. */
function __tasBruteTry(B, win, from) {
  __tasBruteRestore(B, from);
  const tr = B.tracker;
  tr.load(from ? from.tr : B.s0);
  const id = B.car.id, S = B.S, E = B.E, C = B.C, tail = B.tail, f0 = from ? from.f : S;
  let f = f0;
  try {
    while (f < C) {
      const k = f <= E ? win[f - S] : tail[f - E - 1];
      t._updateCarModel(id, 0 != (1 & k), 0 != (8 & k), 0 != (4 & k), 0 != (2 & k), 0 != (16 & k), i);
      f++;
      if (__tasBruteRead(B, f, !0)) break;
    }
  } catch (x) { B.frames += f - f0; return __tasBruteTrap(B, x); }
  B.frames += f - f0; B.skipped += f0 - S;
  return tr.result();
}

/**
 * An exhaustive pattern: from the saved state at variable `from`'s tick (-1: the start time), saving the
 * state at each later variable's tick as it gets there (from keepFrom on; the next pattern starts at one of them).
 */
function __tasBrutePattern(B, win, from) {
  const st = from >= 0 ? B.at[from] : null;
  __tasBruteRestore(B, st);
  const tr = B.tracker;
  tr.load(st ? st.tr : B.s0);
  const id = B.car.id, S = B.S, E = B.E, C = B.C, tail = B.tail, vars = B.vars, V = vars.length, f0 = st ? st.f : S;
  let f = f0, next = from + 1;
  B.atOk = from + 1;
  try {
    while (f < C) {
      if (next < V && f === vars[next].t) {
        if (next >= B.keepFrom) {
          if (B.at[next] && B.pool.length < 64) B.pool.push(B.at[next].data);
          B.at[next] = __tasBruteTake(B, f);
        }
        next++; B.atOk = next;
      }
      const k = f <= E ? win[f - S] : tail[f - E - 1];
      t._updateCarModel(id, 0 != (1 & k), 0 != (8 & k), 0 != (4 & k), 0 != (2 & k), 0 != (16 & k), i);
      f++;
      if (__tasBruteRead(B, f, !0)) break;
    }
  } catch (x) { B.frames += f - f0; B.atOk = from + 1; return __tasBruteTrap(B, x); }
  B.frames += f - f0; B.skipped += f0 - S;
  // the physics' own JavaScript wrote memory on the way: the states saved here could miss a page
  if (self.__tasJsTouched) B.atOk = from + 1;
  return tr.result();
}

/** A try that stopped the physics (it trapped): the memory and the stack put back whole, and a score that never wins. */
function __tasBruteTrap(B, x) {
  B.traps++; B.lastTrap = String((x && x.message) || x);
  __tasBruteRestore(B, null, !0);
  return { clean: !1, hits: -1, n: B.tracker.n, D: -Infinity, V: 0, T: Infinity, gap: null, at: 0, touch: -1, touchT: 0, value: -Infinity, times: [], speeds: [], trap: !0 };
}

/** The saved state a try starts at: the last one at or before the first tick where it differs from its parent. */
function __tasBruteFrom(snaps, parent, win, S) {
  if (null == snaps || 0 === snaps.length) return null;
  const n = win.length;
  let d = 0;
  while (d < n && win[d] === parent[d]) d++;
  const tick = S + d;
  let lo = 0, hi = snaps.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (snaps[mid].f <= tick) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at >= 0 ? snaps[at] : null;
}

/** A try that beat its population's best, run again from a full copy (with saved states of its own when `save`): the score that is reported. */
function __tasBruteConfirm(B, win, fast, save) {
  const c = __tasBruteKeep(B, win, save);
  if (JSON.stringify(c.score) !== JSON.stringify(fast)) B.mismatches++;
  return c;
}

/** The next try: a change on a population's best (random), or the next pattern (exhaustive). False when this worker is done. */
function __tasBruteStep(B) {
  const K = self.TASBruteCore;
  if (B.search === 'exhaustive') {
    if (B.left === 0n) return !1;
    // the next pattern (the block's first as it is). The first variable that changed: every tick before it is
    // the same as last time, so the try starts at the saved state of that variable's tick (or the latest good one before it)
    const j = B.k === 0 ? 0 : K.nextPattern(B.vars, B.digits);
    if (j < 0) return !1;
    B.left--; B.k++;
    const win = K.patternWindow(B.win0, B.S, B.vars, B.digits, B.scratch), p = B.pops[0], at = Math.min(j, B.atOk - 1);
    const s = __tasBrutePattern(B, win, at >= B.keepFrom ? at : -1);
    B.tries++; p.tries++;
    if (K.better(s, p.score)) {
      const c = __tasBruteConfirm(B, win, s, !1);
      if (K.better(c.score, p.score)) { p.win = win.slice(); p.score = c.score; postMessage({ __tas: 'brute-found', id: B.id, pop: p.id, win: p.win, score: c.score, tries: p.tries }); }
    }
    return !0;
  }
  const open = B.pops.filter((p) => !(p.budget > 0) || p.tries < p.budget);
  if (!open.length) return !1;
  const p = open[B.tries % open.length];
  // a best from another thread: its saved states, once
  if (null == p.snaps) { const c = __tasBruteConfirm(B, p.win, p.score, !0); p.snaps = c.snaps || []; }
  const win = K.mutate(p.win, B.ctx, B.rng, B.scratch);
  if (null == win) { if (++B.idle > 5000) throw new Error('no change fits the settings (check the keys, their times and the change types)'); return !0; }
  B.idle = 0;
  const hk = K.hashWindow(win) || 1, slot = hk % B.seen.length;
  if (B.seen[slot] === hk) { B.repeats++; return !0; }
  B.seen[slot] = hk;
  const s = __tasBruteTry(B, win, __tasBruteFrom(p.snaps, p.win, win, B.S));
  B.tries++; p.tries++;
  if (K.better(s, p.score)) {
    const c = __tasBruteConfirm(B, win, s, !0);
    if (K.better(c.score, p.score)) {
      __tasBruteDrop(B, p);
      p.win = win.slice(); p.score = c.score; p.snaps = c.snaps || [];
      postMessage({ __tas: 'brute-found', id: B.id, pop: p.id, win: p.win, score: c.score, tries: p.tries });
    } else __tasBruteRelease(B, c.snaps);
  }
  return !0;
}

/** A slice of tries (~25 ms), a progress report now and then, and the next slice straight after (messages get in between). */
function __tasBruteSlice() {
  const B = __tasS().B;
  if (null == B || B.stopped) return;
  const t0 = performance.now();
  let more = !0;
  try {
    while (more && performance.now() - t0 < 25) more = __tasBruteStep(B);
  } catch (x) {
    B.stopped = !0;
    postMessage({ __tas: 'brute-error', id: B.id, message: String((x && x.message) || x) });
    return;
  }
  const now = performance.now();
  B.busy += now - t0;
  if (!more || now - B.lastReport > 250) {
    B.lastReport = now;
    let saved = 0;
    const seenSnaps = new Set();
    for (const p of B.pops) if (p.snaps && !seenSnaps.has(p.snaps)) { seenSnaps.add(p.snaps); for (const s of p.snaps) saved += s.data.length; }
    if (B.at) for (const s of B.at) if (s) saved += s.data.length;
    postMessage({ __tas: 'brute-progress', id: B.id, tries: B.tries, frames: B.frames, skipped: B.skipped, keeps: B.keeps, busy: B.busy, restore: B.restore, repeats: B.repeats,
      pops: B.pops.map((p) => [p.id, p.tries]), k: B.k, heap: t.HEAPU8.length, saved, fulls: B.fulls, traps: B.traps, lastTrap: B.lastTrap, mismatches: B.mismatches,
      checked: B.checked, badPages: B.badPages, js: self.__tasJsCalls || 0 });
  }
  if (!more) { B.stopped = !0; postMessage({ __tas: 'brute-done', id: B.id }); return; }
  B.port.postMessage(0);
}
