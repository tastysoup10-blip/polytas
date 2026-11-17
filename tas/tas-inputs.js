/*
 * PolyTrack TAS — the input format.
 *
 * A run's inputs as text, one change per line:
 *
 *     0,w            hold W from 0 ms
 *     1000,wd        from 1000 ms hold W and D (each line is EVERYTHING held from that moment)
 *     1500,d         from 1500 ms only D: W is released
 *     2000,none      nothing held
 *     tap 3000 3400 a 20 30     # 20 ms A, 30 ms of what was held before, repeated to 3400
 *
 * Keys: w (accelerate), a (left), s (brake/reverse), d (right), r (reset to the last checkpoint —
 * held like any other key). Times are milliseconds, which is one physics tick of the game. `#` starts a
 * comment; blank lines are ignored; lines need not be in order. Before the first line nothing is held.
 *
 * The game keeps a run as five lists of the ticks where each key flips (up, right, down, left, reset);
 * a flip at tick t takes effect at t. Everything here converts to and from that exactly.
 *
 * Loaded by the game page, the editor window and Node (the tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TASInputs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = ['w', 'a', 's', 'd', 'r'];
  const BIT = { w: 1, a: 2, s: 4, d: 8, r: 16 };
  // the game's recording channels, and which key each one is
  const CHANNELS = [['up', 'w'], ['right', 'd'], ['down', 's'], ['left', 'a'], ['reset', 'r']];
  const MAX_TICK = 5999999;            // the game's limit (Recording.maxFrames)

  /** Bits → canonical text: 'wd', 'none'. */
  function keysText(bits) {
    if (!bits) return 'none';
    let t = '';
    for (const k of KEYS) if (bits & BIT[k]) t += k;
    return t;
  }

  /** Text → bits, or an error. 'dw' is fine (→ wd); 'none' is nothing. */
  function parseKeys(text) {
    const t = String(text).trim().toLowerCase();
    if (t === 'none' || t === '-' || t === '') return { bits: 0, dup: false };
    let bits = 0, dup = false;
    for (const ch of t) {
      if (!(ch in BIT)) return { error: 'unknown key "' + ch + '" (keys are w a s d r, or none)' };
      if (bits & BIT[ch]) dup = true;
      bits |= BIT[ch];
    }
    return { bits, dup };
  }

  const INT = /^\d+$/;

  /**
   * Text → { items, problems }. An item is { kind:'line', line, t, bits } or
   * { kind:'tap', line, start, end, bits, hold, release }. Problems are { line, level, message }
   * with line counted from 1; level 'error' stops a run from being applied, 'warning' does not.
   */
  function parse(text) {
    const items = [], problems = [];
    const lines = String(text).split(/\r\n|\r|\n/);
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      const hash = raw.indexOf('#');
      const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
      if (!body) continue;
      const line = n + 1;
      const err = (message) => problems.push({ line, level: 'error', message });
      const warn = (message) => problems.push({ line, level: 'warning', message });
      if (/^tap\b/i.test(body)) {
        const parts = body.split(/[\s,]+/).filter(Boolean);
        if (parts.length !== 6) { err('a tap is: tap <start> <end> <keys> <hold> <release>'); continue; }
        const [, s, e, keys, h, r] = parts;
        if (![s, e, h, r].every((x) => INT.test(x))) { err('tap times must be whole numbers of milliseconds'); continue; }
        const start = Number(s), end = Number(e), hold = Number(h), release = Number(r);
        const k = parseKeys(keys);
        if (k.error) { err(k.error); continue; }
        if (end <= start) { err('a tap has to end after it starts'); continue; }
        if (hold <= 0 || release <= 0) { err('hold and release have to be at least 1 ms'); continue; }
        if (end > MAX_TICK) { err('times stop at ' + MAX_TICK + ' ms'); continue; }
        if (k.dup) warn('a key is written twice');
        items.push({ kind: 'tap', line, start, end, bits: k.bits, hold, release });
        continue;
      }
      const comma = body.indexOf(',');
      if (comma < 0) { err('a line is: <time>,<keys> — e.g. 1000,wd'); continue; }
      const ts = body.slice(0, comma).trim(), ks = body.slice(comma + 1).trim();
      if (!INT.test(ts)) { err(/^-/.test(ts) ? 'times cannot be negative' : 'the time has to be a whole number of milliseconds'); continue; }
      const t = Number(ts);
      if (t > MAX_TICK) { err('times stop at ' + MAX_TICK + ' ms'); continue; }
      const k = parseKeys(ks);
      if (k.error) { err(k.error); continue; }
      if (k.dup) warn('a key is written twice');
      items.push({ kind: 'line', line, t, bits: k.bits });
    }
    // order, overlaps and redundancy are warnings (the run is still well defined)
    let prevT = -1, unsortedShown = false;
    for (const it of items) {
      const t = it.kind === 'line' ? it.t : it.start;
      if (t < prevT && !unsortedShown) { problems.push({ line: it.line, level: 'warning', message: 'lines are not in time order (that is fine; Sort puts them in order)' }); unsortedShown = true; }
      prevT = Math.max(prevT, t);
    }
    // what starts inside each tap: found by binary search in time order, so thousands of taps and lines stay quick
    const taps = items.filter((i) => i.kind === 'tap');
    if (taps.length) {
      const byStart = taps.slice().sort((a, b) => a.start - b.start || a.line - b.line);
      const plain = items.filter((i) => i.kind === 'line').sort((a, b) => a.t - b.t || a.line - b.line);
      const after = (arr, at, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (at(arr[m]) <= v) lo = m + 1; else hi = m; } return lo; };
      for (const tap of taps) {
        for (let j = after(byStart, (x) => x.start, tap.start); j < byStart.length && byStart[j].start <= tap.end; j++) {
          problems.push({ line: byStart[j].line, level: 'warning', message: 'this tap starts inside the tap on line ' + tap.line + ', and replaces it from here' });
        }
        for (let j = after(plain, (x) => x.t, tap.start); j < plain.length && plain[j].t <= tap.end; j++) {
          problems.push({ line: plain[j].line, level: 'warning', message: 'inside the tap on line ' + tap.line + ': it holds until the tap next switches' });
        }
      }
    }
    return { items, problems: problems.sort((a, b) => a.line - b.line) };
  }

  /** Whether one line of text, on its own, is an error (the editor marks those as you type). */
  function lineError(raw) {
    const p = parse(raw).problems;
    for (const x of p) if (x.level === 'error') return x.message;
    return null;
  }

  /**
   * Items → the state at every tick, as a list of changes [{t, bits}] (ascending, each different from
   * the one before, the first at t ≥ 0 differing from 'none'). The rules:
   *   - each tick, a plain line at that tick wins over a tap's switch at that tick, and of several
   *     plain lines at one tick the later one in the text wins;
   *   - a tap captures what was held just before its start, once, and alternates its keys with that;
   *     whatever it shows at its end tick stays held after it;
   *   - a tap starting inside another takes over from there.
   */
  function expand(items) {
    const lines = items.filter((i) => i.kind === 'line');
    const taps = items.filter((i) => i.kind === 'tap').slice().sort((a, b) => a.start - b.start || a.line - b.line);
    // the last plain line at each tick (in text order)
    const atTick = new Map();
    for (const l of lines) { const prev = atTick.get(l.t); if (!prev || l.line > prev.line) atTick.set(l.t, l); }
    // every tick where something may change: plain lines and tap switches
    const events = new Set(atTick.keys());
    for (const tap of taps) {
      const period = tap.hold + tap.release;
      for (let t = tap.start; t <= tap.end; t += period) {
        events.add(t);
        if (t + tap.hold <= tap.end) events.add(t + tap.hold);
      }
    }
    const ticks = [...events].sort((a, b) => a - b);
    const changes = [];
    let current = 0, active = null, baseline = 0, ti = 0;
    for (const t of ticks) {
      // a tap starting here takes over (the latest-starting one wins; ties: later in the text)
      while (ti < taps.length && taps[ti].start <= t) {
        if (taps[ti].start === t) { active = taps[ti]; baseline = current; }
        else if (!active || taps[ti].start > active.start) { /* started between events: cannot happen */ }
        ti++;
      }
      if (active && t > active.end) active = null;
      let tapOut = null;
      if (active && t >= active.start && t <= active.end) {
        const phase = (t - active.start) % (active.hold + active.release);
        if (t === active.start || phase === 0 || phase === active.hold) tapOut = phase < active.hold ? active.bits : baseline;
      }
      const plain = atTick.get(t);
      const next = plain ? plain.bits : tapOut != null ? tapOut : current;
      if (next !== current) { changes.push({ t, bits: next }); current = next; }
    }
    return changes;
  }

  /** The state held at tick t, from a change list. */
  function stateAt(changes, t) {
    let lo = 0, hi = changes.length - 1, bits = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (changes[mid].t <= t) { bits = changes[mid].bits; lo = mid + 1; } else hi = mid - 1; }
    return bits;
  }

  /** Index of the change in force at tick t (-1 before the first). */
  function changeIndexAt(changes, t) {
    let lo = 0, hi = changes.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (changes[mid].t <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k;
  }

  function sameChanges(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i].t !== b[i].t || a[i].bits !== b[i].bits) return false;
    return true;
  }

  /** Changes → plain text, one line per change. */
  function toText(changes) {
    return changes.map((c) => c.t + ',' + keysText(c.bits)).join('\n') + (changes.length ? '\n' : '');
  }

  /**
   * The fewest lines that give exactly the same run: one line per change, and runs that alternate
   * between two states with constant durations — where the second is what was held before the run —
   * folded into a tap when that saves lines (at least `minRun` changes). The result is re-expanded
   * and compared; if it differed, the plain lines are returned instead (it never changes a run).
   */
  function compact(changes, minRun) {
    minRun = Math.max(4, minRun | 0 || 4);
    const out = [];
    let i = 0;
    while (i < changes.length) {
      const base = i === 0 ? 0 : changes[i - 1].bits;
      const A = changes[i].bits;
      // A, base, A, base ... with constant A-length and base-length
      let j = i + 1, hold = -1, release = -1;
      if (j < changes.length && changes[j].bits === base && base !== A) {
        hold = changes[j].t - changes[i].t;
        let k = j;
        release = -1;
        while (k + 1 < changes.length) {
          const want = (k - i) % 2 === 1 ? A : base;
          const len = changes[k + 1].t - changes[k].t;
          const expectLen = (k - i) % 2 === 1 ? (release < 0 ? len : release) : hold;
          if (changes[k + 1].bits !== want || len !== expectLen) break;
          if ((k - i) % 2 === 1 && release < 0) release = len;
          k++;
        }
        j = k;
      }
      const count = j - i + 1;              // changes covered by i..j
      if (hold > 0 && release > 0 && count >= minRun) {
        // end on the last change of the run; what it shows there stays held, as in the game's rules
        out.push({ kind: 'tap', start: changes[i].t, end: changes[j].t, bits: A, hold, release });
        i = j + 1;
      } else {
        out.push({ kind: 'line', t: changes[i].t, bits: changes[i].bits });
        i++;
      }
    }
    const text = out.map((o) => (o.kind === 'line' ? o.t + ',' + keysText(o.bits)
      : 'tap ' + o.start + ' ' + o.end + ' ' + keysText(o.bits) + ' ' + o.hold + ' ' + o.release)).join('\n') + (out.length ? '\n' : '');
    const check = parse(text);
    if (check.problems.some((p) => p.level === 'error') || !sameChanges(expand(check.items), changes)) {
      if (typeof console !== 'undefined') console.error('[tas] compaction would change the run; kept plain lines');
      return toText(changes);
    }
    return text;
  }

  /**
   * Text sorted by time. Lines above the first timed line stay at the top (a header); any other
   * comment or blank line travels with the timed line below it; anything after the last timed line
   * stays at the end. Lines at the same time keep their order, so the run does not change (the later
   * line at a tick still wins).
   */
  function sortText(text) {
    const rows = String(text).split(/\r\n|\r|\n/);
    const timeOf = (raw) => {
      const body = raw.replace(/#.*/, '').trim();
      const m = /^tap\s+(\d+)/i.exec(body) || /^(\d+)\s*,/.exec(body);
      return m ? Number(m[1]) : null;
    };
    const header = [];
    let n = 0;
    while (n < rows.length && timeOf(rows[n]) == null) header.push(rows[n++]);
    const blocks = [];
    let pending = [];
    for (; n < rows.length; n++) {
      const t = timeOf(rows[n]);
      if (t == null) { pending.push(rows[n]); continue; }
      blocks.push({ t, n, rows: pending.concat([rows[n]]) });
      pending = [];
    }
    blocks.sort((a, b) => a.t - b.t || a.n - b.n);
    return header.concat(blocks.flatMap((b) => b.rows), pending).join('\n');
  }

  // ---------------------------------------------------------------- the game's recording
  /** Changes → the five toggle lists the game's Recording is built from. */
  function toChannels(changes) {
    const ch = { up: [], right: [], down: [], left: [], reset: [] };
    let prev = 0;
    for (const c of changes) {
      for (const [name, key] of CHANNELS) {
        const was = (prev & BIT[key]) !== 0, now = (c.bits & BIT[key]) !== 0;
        if (was !== now) ch[name].push(c.t);
      }
      prev = c.bits;
    }
    return ch;
  }

  /**
   * Whether a key is held at frame t, exactly as the game reads a toggle list: it scans from the
   * start, stops at the first entry equal to t or past it, and the key is held when the index it
   * stopped on is even. For a list that only goes up this is "an odd number of toggles at or before
   * t"; the game's own recordings are always like that, but a list that repeats or goes back is read
   * this way too, so any recording turns into text that drives the same.
   */
  function heldInGame(list, t) {
    let i = -1;
    for (let r = 0; r < list.length; r++) { const s = list[r]; if (s === t) { i = r; break; } if (s > t) break; i = r; }
    return (i + 1) % 2 !== 0;
  }
  const rising = (list) => { for (let i = 1; i < list.length; i++) if (!(list[i] > list[i - 1])) return false; return true; };

  /** The five toggle lists → changes. */
  function fromChannels(ch) {
    if (!CHANNELS.every(([name]) => rising(ch[name] || []))) {
      // an unusual list: the state can only change at an entry or the frame after it; ask the game's rule there
      const ticks = new Set();
      for (const [name] of CHANNELS) for (const t of ch[name] || []) { if (t >= 0) ticks.add(t); ticks.add(t + 1); }
      const changes = [];
      let prev = 0;
      for (const t of [...ticks].filter((x) => x >= 0).sort((a, b) => a - b)) {
        let bits = 0;
        for (const [name, key] of CHANNELS) if (heldInGame(ch[name] || [], t)) bits |= BIT[key];
        if (bits !== prev) { changes.push({ t, bits }); prev = bits; }
      }
      return changes;
    }
    const ticks = new Set();
    for (const [name] of CHANNELS) for (const t of ch[name] || []) ticks.add(t);
    const order = [...ticks].sort((a, b) => a - b);
    const idx = {}, state = {};
    for (const [name] of CHANNELS) { idx[name] = 0; state[name] = false; }
    const changes = [];
    let prev = 0;
    for (const t of order) {
      for (const [name] of CHANNELS) {
        const list = ch[name] || [];
        while (idx[name] < list.length && list[idx[name]] <= t) { state[name] = !state[name]; idx[name]++; }
      }
      let bits = 0;
      for (const [name, key] of CHANNELS) if (state[name]) bits |= BIT[key];
      if (bits !== prev) { changes.push({ t, bits }); prev = bits; }
    }
    return changes;
  }

  /** The last tick at which anything changes (0 when nothing does). */
  function lastTick(changes) { return changes.length ? changes[changes.length - 1].t : 0; }

  /**
   * The first tick at which two change lists hold different keys (Infinity when they never do). A run
   * is the same as before up to that tick, so it can be resumed from any moment at or before it.
   */
  function firstDifference(a, b) {
    let i = 0, j = 0, sa = 0, sb = 0;
    for (;;) {
      const t = Math.min(i < a.length ? a[i].t : Infinity, j < b.length ? b[j].t : Infinity);
      if (t === Infinity) return Infinity;
      while (i < a.length && a[i].t === t) sa = a[i++].bits;
      while (j < b.length && b[j].t === t) sb = b[j++].bits;
      if (sa !== sb) return t;
    }
  }

  return { KEYS, BIT, CHANNELS, MAX_TICK, keysText, parseKeys, parse, lineError, expand, stateAt, changeIndexAt, sameChanges, toText, compact, sortText, toChannels, fromChannels, heldInGame, lastTick, firstDifference };
});
