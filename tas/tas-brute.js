/*
 * PolyTrack TAS — the bruteforce, game side.
 *
 * The bruteforce window (the "Open the bruteforce" key, F; tas/brute/) is where it is set up and where
 * its results show; this file is what it works on:
 *   - the objectives of the track you are on: its checkpoints and finish (in the game's order, which
 *     cannot change), and trigger boxes and no-gos you place — kept per track;
 *   - the boxes in the 3D view: trigger boxes, no-gos, and while the window is open the checkpoints' own
 *     hitboxes and the car's;
 *   - the run: physics workers of its own (one try at a time each, tas-brute-worker.js), populations
 *     spread over them, each new best told to the window, and the overall best shown on the car as it
 *     improves. Every best that is shown is checked: the Replay Editor's own simulation of it, from the
 *     start, must give the same score to the last digit, or the window says so;
 *   - the last run on each track, while the game is open: leaving the track stops a run, and back on it
 *     its results still put their inputs on the car they were found for.
 *
 * The scoring and the changes a try makes are in tas-brute-core.js.
 */
(function () {
  'use strict';

  const K = window.TASBruteCore, I = window.TASInputs;
  const STORE = 'tas-v1-brute:';                   // + track id → objectives and settings
  const log = (...a) => console.log('[tas] bruteforce:', ...a);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { log('could not save', k, e); } },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const int = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Math.round(num(Number(v), d))));
  const secs = (ms) => (ms / 1000).toFixed(6);          // seconds, to the microsecond

  // the inputs a try may use: keys held together, as the input editor writes them ('wd', 'none')
  const DEFAULT_INPUTS = () => ['w', 'wa', 'wd'].map((keys) => ({ keys, toggle: true, insert: true, shift: true, ranges: '' }));
  const MAX_INPUTS = 32;
  const DEFAULTS = () => ({
    S: 0, E: 500, C: 501,
    weights: { toggle: 1, insert: 1, shift: 1 },
    insert: [1, 40], shift: [1, 15], per: [1, 3],
    inputs: DEFAULT_INPUTS(),
    alpha: 50, scoreMode: 'check', speed: 'raw',
    search: 'random', populations: 4, iterations: 0, threads: 0,
    live: true, showBoxes: true,
  });
  const MAX_THREADS = 32;
  const autoThreads = () => Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 2));

  // ---------------------------------------------------------------- the boxes in the 3D view
  const FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const COLOR = { trigger: 0x4fc3f7, nogo: 0xff5252, off: 0x9e9e9e, cp: 0xffd54a, fin: 0x81c784, car: 0xffffff };

  class BoxView {
    constructor(T, scene, faces) {
      this.scene = scene;
      this.pos = new Float32Array(24 * 3);
      this.geo = new T.BufferGeometry();
      this.attr = new T.BufferAttribute(this.pos, 3);
      this.geo.setAttribute('position', this.attr);
      this.lineMat = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
      this.lines = new T.LineSegments(this.geo, this.lineMat);
      this.lines.frustumCulled = false; this.lines.renderOrder = 3;
      scene.add(this.lines);
      if (faces) {
        this.fpos = new Float32Array(36 * 3);
        this.fgeo = new T.BufferGeometry();
        this.fattr = new T.BufferAttribute(this.fpos, 3);
        this.fgeo.setAttribute('position', this.fattr);
        this.faceMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false, side: 2 });
        this.mesh = new T.Mesh(this.fgeo, this.faceMat);
        this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
        scene.add(this.mesh);
      }
    }
    set(box) {
      const c = K.corners(box);
      let i = 0;
      for (const [a, b] of EDGES) for (const k of [a, b]) { this.pos[i++] = c[k][0]; this.pos[i++] = c[k][1]; this.pos[i++] = c[k][2]; }
      this.attr.needsUpdate = true;
      if (this.mesh) {
        i = 0;
        for (const f of FACES) for (const k of [f[0], f[1], f[2], f[0], f[2], f[3]]) { this.fpos[i++] = c[k][0]; this.fpos[i++] = c[k][1]; this.fpos[i++] = c[k][2]; }
        this.fattr.needsUpdate = true;
      }
    }
    style(color, lineOpacity, faceOpacity, visible) {
      this.lineMat.color.setHex(color); this.lineMat.opacity = lineOpacity;
      this.lines.visible = visible;
      if (this.mesh) { this.faceMat.color.setHex(color); this.faceMat.opacity = faceOpacity; this.mesh.visible = visible && faceOpacity > 0; }
    }
    dispose() {
      this.scene.remove(this.lines); this.geo.dispose(); this.lineMat.dispose();
      if (this.mesh) { this.scene.remove(this.mesh); this.fgeo.dispose(); this.faceMat.dispose(); }
    }
  }

  const Brute = {
    tas: null, api: null, T: null, scene: null,
    track: null,             // { id, name, cpBoxes: [[box]], finBoxes: [box] }
    model: null,             // { objectives: [...], settings: {...} }
    selected: null, windowOpen: false, shown: false, views: new Map(), carView: null,   // shown: the window's bruteforce part is showing
    ack: 0,                  // the last change from the window (its seq) that is in what we send it
    run: null, results: [], lastRun: null, verify: null,
    past: new Map(),         // track id → { run, results, verify }: the last run on each track, while the game is open
    logRun: null,            // the run whose results the window's output lists

    // ================================================================ session
    attach(tas) {
      this.detach();
      this.tas = tas; this.api = tas.api;
      const track = this.api.track();
      let cps = [], fins = [];
      try { cps = track.getCheckpoints(); fins = track.getFinishes(); } catch (e) { console.error('[tas] bruteforce: the track\'s checkpoints', e); }
      const orders = [...new Set(cps.map((p) => p.checkpointOrder))].sort((a, b) => a - b);
      this.track = {
        id: tas.session.trackId, name: tas.session.trackName,
        cpBoxes: orders.map((o) => cps.filter((p) => p.checkpointOrder === o).map(K.partBox)),
        finBoxes: fins.map(K.partBox),
      };
      this.model = this.loadModel();
      try {
        const T = this.api.three(), scene = this.api.scene();
        if (T && T.LineSegments && new T.LineSegments().isLineSegments && scene) { this.T = T; this.scene = scene; }
      } catch (e) { console.error('[tas] bruteforce: boxes unavailable', e); }
      // back on a track with a run from before: its results put inputs on its car again (found in this Replay Editor anew)
      const past = this.past.get(this.track.id);
      this.run = null; this.lastRun = past ? past.run : null; this.results = past ? past.results : []; this.verify = past ? past.verify : null;
      if (this.lastRun) this.lastRun.k = this.carIndex(this.lastRun.car);
      this.sendState(true);
      // the window's output: this track's last run, or nothing (never another track's)
      if (this.logRun !== this.lastRun) { this.send({ type: 'results', lines: this.results.map((r) => r.line), verify: this.verify }); this.logRun = this.lastRun; }
    },

    detach() {
      if (this.run) this.stop(true);
      const last = this.run || this.lastRun;
      if (this.track && last) {
        this.past.delete(this.track.id);
        this.past.set(this.track.id, { run: last, results: this.results, verify: this.verify && !this.verify.pending ? this.verify : null });
        while (this.past.size > 8) this.past.delete(this.past.keys().next().value);
      }
      for (const v of this.views.values()) v.dispose();
      this.views.clear();
      if (this.carView) { this.carView.dispose(); this.carView = null; }
      if (this.mark) { this.mark.remove(); this.mark = null; }
      if (this.tas && window.tasBridge && window.tasBridge.sendBrute) window.tasBridge.sendBrute({ type: 'detached' });
      this.tas = this.api = this.T = this.scene = null;
      this.track = null; this.model = null; this.selected = null;
    },

    // ================================================================ objectives and settings
    builtinIds() { return this.track.cpBoxes.map((_, k) => 'cp' + k).concat(this.track.finBoxes.length ? ['fin'] : []); },

    loadModel() {
      let saved = null;
      try { saved = JSON.parse(store.get(STORE + this.track.id) || 'null'); } catch { saved = null; }
      const want = this.builtinIds();
      let list = saved && Array.isArray(saved.objectives) ? saved.objectives.filter((o) => o && (o.kind === 'box' ? Array.isArray(o.c) && Array.isArray(o.rot) && Array.isArray(o.size) : want.includes(o.id))) : [];
      // the checkpoints and the finish, in the game's order, each where it was among the trigger boxes
      for (let i = 0; i < want.length; i++) {
        if (list.some((o) => o.id === want[i])) continue;
        const prev = i > 0 ? list.findIndex((o) => o.id === want[i - 1]) : -1;
        const item = want[i] === 'fin' ? { id: 'fin', kind: 'fin', enabled: true } : { id: want[i], kind: 'cp', k: Number(want[i].slice(2)), enabled: true };
        if (want[i] === 'fin' && prev < 0) list.push(item); else list.splice(prev + 1, 0, item);
      }
      const order = list.filter((o) => o.kind !== 'box').map((o) => o.id);
      if (order.join() !== want.join()) {
        // stored out of the game's order (the track changed): put them back in order in the same places
        const slots = list.map((o, i) => (o.kind !== 'box' ? i : -1)).filter((i) => i >= 0);
        const items = want.map((id) => list.find((o) => o.id === id));
        slots.forEach((s, j) => { list[s] = items[j]; });
      }
      const settings = Object.assign(DEFAULTS(), saved && saved.settings || {});
      // (settings saved before the input list had a row per key: those start from the default list)
      if (!Array.isArray(settings.inputs)) settings.inputs = DEFAULT_INPUTS();
      delete settings.keys;
      settings.weights = Object.assign({ toggle: 1, insert: 1, shift: 1 }, settings.weights || {});
      return { objectives: list, settings, next: (saved && saved.next) || 1 };
    },
    saveModel() { if (this.track) store.set(STORE + this.track.id, JSON.stringify(this.model)); },

    /** Who car k is, to find it again in a later Replay Editor: the TAS car, or a run by its name and length. */
    carOf(k) { const s = this.tas.session.cars[k]; return { kind: s.kind, name: s.name, len: s.origLen }; },
    /** Where that car is in this Replay Editor (null: not here). */
    carIndex(car) {
      const cars = this.tas.session.cars;
      for (let k = 0; k < cars.length; k++) if (cars[k].kind === car.kind && (car.kind === 'tas' || (cars[k].name === car.name && cars[k].origLen === car.len))) return k;
      return null;
    },

    nameOf(o) {
      if (o.kind === 'cp') return 'Checkpoint ' + (o.k + 1);
      if (o.kind === 'fin') return 'Finish';
      return o.name || (o.nogo ? 'No-go' : 'Trigger');
    },

    /** The groups the score goes through, in order (disabled ones and no-gos left out; "or" joins the one above). */
    groups() {
      const out = [];
      for (const o of this.model.objectives) {
        if (!o.enabled || (o.kind === 'box' && o.nogo)) continue;
        const member = o.kind === 'box' ? { kind: 'box', box: K.triggerBox(o) } : o.kind === 'cp' ? { kind: 'cp', k: o.k, boxes: this.track.cpBoxes[o.k] } : { kind: 'fin', boxes: this.track.finBoxes };
        if (!(o.kind === 'box' && o.same && out.length)) out.push({ name: '', names: [], members: [], ids: [] });
        const g = out[out.length - 1];
        g.members.push(member); g.names.push(this.nameOf(o)); g.ids.push(o.id);
      }
      for (const g of out) g.name = [...new Set(g.names)].join(' or ');
      return out;
    },
    nogos() { return this.model.objectives.filter((o) => o.kind === 'box' && o.nogo && o.enabled).map((o) => ({ name: this.nameOf(o), box: K.triggerBox(o) })); },

    /** The pose of the watched car at the replay's moment: its frame's own state. */
    carPose() {
      const cars = this.api.cars(), entry = cars[this.api.focus()];
      const f = this.tas.frameFor(this.tas.viewer, entry, Math.round(this.api.time() * 1000));
      const st = entry.replay.getFrame(f) || entry.replay.getFrame(entry.replay.getLastFrame().numberOfFrames);
      return { p: [st.position.x, st.position.y, st.position.z], q: [st.quaternion.x, st.quaternion.y, st.quaternion.z, st.quaternion.w], f };
    },
    /** A box where the car's own box is now, turned the way the car points (level). */
    boxAtCar(size) {
      const pose = this.carPose(), car = K.carBox(pose.p[0], pose.p[1], pose.p[2], pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
      const fwd = car.u[2], yaw = Math.atan2(fwd[0], fwd[2]) * 180 / Math.PI;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      return { c: car.c.map(r3), rot: [r3(yaw), 0, 0], size: size.slice(), f: pose.f };
    },

    /**
     * Where in the order a new box goes: after everything the watched car reached by now in its run, before
     * what it reaches later (checkpoints by their times, trigger boxes by the first frame its box overlaps them).
     */
    insertIndex(now) {
      const entry = this.api.cars()[this.api.focus()];
      const cp = entry.checkpointTimes.map((t) => t.numberOfFrames);
      const fin = this.tas.finishOf(this.api.focus());
      const list = this.model.objectives;
      const when = list.map((o) => {
        if (o.kind === 'cp') return cp[o.k] != null ? cp[o.k] : Infinity;
        if (o.kind === 'fin') return fin != null ? fin : Infinity;
        if (o.nogo) return null;
        const box = K.triggerBox(o), last = entry.replay.getLastFrame().numberOfFrames;
        for (let f = 0; f <= last; f++) {
          const s = entry.replay.getFrame(f);
          if (s && K.overlaps(K.carBox(s.position.x, s.position.y, s.position.z, s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w), box)) return f;
        }
        return Infinity;
      });
      let at = 0;
      when.forEach((w, i) => { if (w != null && w <= now) at = i + 1; });
      return at;
    },

    addBox(nogo) {
      const b = this.boxAtCar(nogo ? [4, 4, 4] : [10.5, 3.8, 1]);
      const n = this.model.next++;
      const o = { id: 'b' + n, kind: 'box', name: (nogo ? 'No-go ' : 'Trigger ') + n, enabled: true, nogo: !!nogo, same: false, c: b.c, rot: b.rot, size: b.size };
      const list = this.model.objectives;
      list.splice(nogo ? list.length : this.insertIndex(b.f), 0, o);
      this.selected = o.id;
      this.changed();
      return o;
    },
    placeAtCar(id, turnOnly) {
      const o = this.model.objectives.find((x) => x.id === id && x.kind === 'box');
      if (!o) return;
      const b = this.boxAtCar(o.size);
      if (!turnOnly) o.c = b.c;
      o.rot = [b.rot[0], 0, 0];
      this.changed();
    },
    remove(id) {
      const list = this.model.objectives, i = list.findIndex((o) => o.id === id && o.kind === 'box');
      if (i < 0) return;
      list.splice(i, 1);
      if (list[0] && list[0].same) list[0].same = false;
      if (this.selected === id) this.selected = null;
      this.changed();
    },
    /** One place up or down: trigger boxes go anywhere; the checkpoints and the finish never pass each other. */
    move(id, dir) {
      const list = this.model.objectives, i = list.findIndex((o) => o.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      if (list[i].kind !== 'box' && list[j].kind !== 'box') return;
      [list[i], list[j]] = [list[j], list[i]];
      if (list[0].same) list[0].same = false;
      this.changed();
    },

    /**
     * Objectives and settings from the window, checked. Only what it sends changes: an objective's
     * fields that are there, and of x, y, z only those that are not null (one typed number never
     * carries the others along).
     */
    setFromWindow(msg) {
      const m = this.model;
      if (Array.isArray(msg.objectives)) {
        for (const o of msg.objectives) {
          const mine = m.objectives.find((x) => x.id === o.id);
          if (!mine) continue;
          if (o.enabled != null) mine.enabled = !!o.enabled;
          if (mine.kind === 'box') {
            const fin3 = (a, d) => (Array.isArray(a) && a.length === 3 ? a.map((v, i) => (v == null ? d[i] : num(Number(v), d[i]))) : d);
            if (o.name != null && String(o.name).trim()) mine.name = String(o.name).slice(0, 40);
            if (o.nogo != null) mine.nogo = !!o.nogo;
            if (o.same != null) mine.same = !!o.same;
            if (mine.nogo) mine.same = false;
            mine.c = fin3(o.c, mine.c); mine.rot = fin3(o.rot, mine.rot);
            mine.size = fin3(o.size, mine.size).map((v) => Math.max(0.05, Math.abs(v)));
          }
        }
      }
      if (msg.settings) {
        const s = m.settings, w = msg.settings;
        const T = 5999999;
        if (w.S != null) s.S = int(w.S, s.S, 0, T);
        if (w.E != null) s.E = int(w.E, s.E, 0, T);
        if (w.C != null) s.C = int(w.C, s.C, 0, T);
        if (w.weights) for (const k of K.TYPES) if (w.weights[k] != null) s.weights[k] = Math.max(0, num(Number(w.weights[k]), s.weights[k]));
        for (const f of ['insert', 'shift', 'per']) if (Array.isArray(w[f])) s[f] = [int(w[f][0], s[f][0], 1, 100000), int(w[f][1], s[f][1], 1, 100000)];
        if (Array.isArray(w.inputs)) s.inputs = w.inputs.slice(0, MAX_INPUTS).map((r) => ({ keys: String((r && r.keys) || '').slice(0, 12), toggle: !!(r && r.toggle), insert: !!(r && r.insert), shift: !!(r && r.shift), ranges: String((r && r.ranges) || '').slice(0, 400) }));
        if (w.alpha != null) s.alpha = int(w.alpha, s.alpha, 0, 100);
        if (w.scoreMode === 'check' || w.scoreMode === 'hit') s.scoreMode = w.scoreMode;
        if (w.speed === 'raw' || w.speed === 'signed') s.speed = w.speed;
        if (w.search === 'random' || w.search === 'exhaustive') s.search = w.search;
        if (w.populations != null) s.populations = int(w.populations, s.populations, 1, 64);
        if (w.iterations != null) s.iterations = int(w.iterations, s.iterations, 0, 1e12);
        if (w.threads != null) s.threads = int(w.threads, s.threads, 0, MAX_THREADS);
        if (w.live != null) s.live = !!w.live;
        if (w.showBoxes != null) s.showBoxes = !!w.showBoxes;
      }
      if (msg.selected !== undefined) this.selected = msg.selected;
      this.changed(msg.quiet);
    },

    changed(quiet) {
      this.saveModel();
      this.syncViews();
      if (!quiet) this.sendState();
      else this.sendBrief();
    },

    // ================================================================ the window
    openWindow() {
      if (!window.tasBridge || !window.tasBridge.openBrute) { this.tas.toast('The bruteforce needs the desktop build'); return; }
      window.tasBridge.openBrute();
      if (this.windowOpen) this.sendState();
    },
    send(msg) { if (window.tasBridge && window.tasBridge.sendBrute) window.tasBridge.sendBrute(msg); },

    /** What the window shows of the run. */
    runInfo() {
      const r = this.run;
      if (!r) return null;
      const tries = r.threads.reduce((s, t) => s + t.tries, 0), busy = r.threads.reduce((s, t) => s + t.busy, 0);
      const frames = r.threads.reduce((s, t) => s + t.frames, 0), elapsed = performance.now() - r.t0;
      const restore = r.threads.reduce((s, t) => s + (t.restore || 0), 0), sum = (k) => r.threads.reduce((s, t) => s + (t[k] || 0), 0);
      return { running: !r.finished, tries, frames, elapsed, rate: tries / Math.max(0.001, elapsed / 1000), msPerTry: busy / Math.max(1, tries), restorePerTry: restore / Math.max(1, tries),
        usPerFrame: (busy - restore) * 1000 / Math.max(1, frames),
        // frames not simulated (tries started from a saved state), runs from the start time (improvements again from a full copy),
        // memory: saved states, the physics' own; whole-memory restores, tries that trapped, improvements that came out different from a full copy
        skipped: sum('skipped'), keeps: sum('keeps'), saved: sum('saved'), heap: Math.max(0, ...r.threads.map((t) => t.heap || 0)),
        fulls: sum('fulls'), traps: sum('traps'), lastTrap: (r.threads.find((t) => t.lastTrap) || {}).lastTrap || null, mismatches: sum('mismatches'),
        checked: sum('checked'), badPages: sum('badPages'),
        threads: r.threads.length, pops: r.pops.map((p) => ({ id: p.id, tries: r.threads.reduce((s, t) => s + (t.popTries[p.id] || 0), 0) })),
        total: r.total || null, bits: r.bits || 0, search: r.search, repeats: r.threads.reduce((s, t) => s + t.repeats, 0) };
    },

    sendState(force) {
      if (!this.windowOpen && !force) return;
      if (!this.tas || !this.tas.session || !this.model) { this.send({ type: 'detached' }); return; }
      const k = this.api.focus();
      const groups = this.groups(), r = this.run || this.lastRun;
      this.send({
        type: 'state', track: { id: this.track.id, name: this.track.name, checkpoints: this.track.cpBoxes.length, shared: this.track.cpBoxes.map((l) => l.length), finishes: this.track.finBoxes.length },
        car: { index: k, name: this.tas.session.cars[k].name, length: this.api.cars()[k].settings.time.numberOfFrames },
        objectives: this.model.objectives.map((o) => Object.assign({ label: this.nameOf(o) }, o)),
        groups: groups.map((g) => ({ name: g.name, ids: g.ids })),
        settings: this.model.settings, selected: this.selected, decimals: this.decimals(), threadsAuto: autoThreads(),
        // the car the run is on (-1: not in this Replay Editor)
        run: this.runInfo(), runCar: r ? (r.k == null ? -1 : r.k) : null, exhaustive: this.exhaustiveCount(), ack: this.ack,
      });
    },
    sendBrief() { this.send({ type: 'brief', groups: this.groups().map((g) => ({ name: g.name, ids: g.ids })), exhaustive: this.exhaustiveCount(), ack: this.ack }); },

    /**
     * How many patterns the exhaustive search would try with these settings, on the watched car's inputs:
     * { ticks (milliseconds with a choice), total, bits, most (choices at one millisecond) }.
     */
    exhaustiveCount() {
      try {
        const s = this.model.settings, inputs = this.inputsOf(s), changes = this.carChanges();
        const E = Math.max(s.E, s.S);
        const ctx = K.mutationContext({ inputs, S: s.S, E, changes, weights: s.weights, insert: s.insert, shift: s.shift, per: s.per });
        const vars = K.exhaustiveVariables(ctx, K.statesOf(changes, s.S, E)), c = K.patternCount(vars);
        return { ticks: vars.length, total: c.total, bits: c.bits, most: vars.reduce((m, v) => Math.max(m, v.options.length), 0) };
      } catch (e) { return { error: String(e.message || e) }; }
    },
    /** The watched car's inputs as changes (kept while its text is the same). */
    carChanges() {
      const text = this.tas.appliedText(this.api.focus());
      if (!this.changesOf || this.changesOf.text !== text) { const b = this.tas.build(text, 0); this.changesOf = { text, changes: b.errors ? [] : b.changes }; }
      return this.changesOf.changes;
    },
    /** The input list as the bruteforce uses it ({ bits, toggle, insert, shift, ranges }); throws, saying what is wrong. */
    inputsOf(s) {
      const out = [], seen = new Map();
      (s.inputs || []).forEach((r, j) => {
        const text = String(r.keys || '').trim();
        if (!text) throw new Error('input ' + (j + 1) + ' is empty: write keys like wd, or none');
        const k = I.parseKeys(text);
        if (k.error) throw new Error('"' + text + '": ' + k.error);
        if (k.dup) throw new Error('"' + text + '" has a key twice');
        if (seen.has(k.bits)) throw new Error(I.keysText(k.bits) + ' is in the list twice');
        seen.set(k.bits, j);
        let ranges;
        try { ranges = K.parseRanges(r.ranges); } catch (e) { throw new Error(I.keysText(k.bits) + ': ' + e.message); }
        out.push({ bits: k.bits, toggle: !!r.toggle, insert: !!r.insert, shift: !!r.shift, ranges });
      });
      return out;
    },

    decimals() {
      try { const v = parseInt(this.api.settings().getSetting(this.api.settingEnum().TASSpeedometerDecimals), 10); return isFinite(v) ? Math.max(0, Math.min(6, v)) : 2; } catch { return 2; }
    },

    fromWindow(msg) {
      switch (msg.type) {
        case 'hello':
          this.windowOpen = true;
          this.ack = 0;                       // a new window counts its changes from 1
          this.sendState(true);
          this.send({ type: 'results', lines: this.results.map((r) => r.line), verify: this.verify });
          this.logRun = this.run || this.lastRun;
          this.syncViews();
          break;
        case 'closed': this.windowOpen = false; this.shown = false; this.syncViews(); break;
        case 'shown': this.shown = !!msg.on; this.syncViews(); break;
        case 'set':
          if (msg.seq > this.ack) this.ack = msg.seq;   // told back as `ack` in each state and brief
          if (this.model) this.setFromWindow(msg);
          break;
        case 'add': if (this.model) { const o = this.addBox(msg.nogo); this.send({ type: 'added', id: o.id }); } break;
        case 'place': if (this.model) this.placeAtCar(msg.id, !!msg.turnOnly); break;
        case 'remove': if (this.model) this.remove(msg.id); break;
        case 'move': if (this.model) this.move(msg.id, msg.dir < 0 ? -1 : 1); break;
        case 'select': this.selected = msg.id || null; this.syncViews(); break;
        case 'start': this.start(); break;
        case 'stop': this.stop(); break;
        case 'apply': this.applyResult(msg.n); break;
        case 'seek': if (this.api) { this.api.setPaused(true); this.api.seek(Math.max(0, msg.t) / 1000); } break;
        case 'focusGame': break;
      }
    },

    // ================================================================ the 3D view, every frame
    /** The checkpoints' and the car's hitboxes, the selection and the time bar's mark show while the window's bruteforce part does. */
    showing() { return this.windowOpen && this.shown; },

    tick() {
      if (!this.api || !this.model) return;
      this.syncCarView();
      this.paintMark();
    },

    syncViews() {
      if (!this.T || !this.model) return;
      const s = this.model.settings, show = s.showBoxes;
      const seen = new Set();
      for (const o of this.model.objectives) {
        if (o.kind !== 'box') continue;
        seen.add(o.id);
        let v = this.views.get(o.id);
        if (!v) { v = new BoxView(this.T, this.scene, true); this.views.set(o.id, v); }
        v.set(K.triggerBox(o));
        const sel = this.selected === o.id && this.showing();
        const color = !o.enabled ? COLOR.off : o.nogo ? COLOR.nogo : COLOR.trigger;
        v.style(color, sel ? 1 : 0.75, sel ? 0.28 : o.enabled ? 0.12 : 0.05, show);
      }
      // the checkpoints' and the finish's own hitboxes, while the window is open
      this.track.cpBoxes.forEach((list, k) => list.forEach((b, j) => {
        const id = 'cp' + k + ':' + j;
        seen.add(id);
        let v = this.views.get(id);
        if (!v) { v = new BoxView(this.T, this.scene, false); v.set(b); this.views.set(id, v); }
        const o = this.model.objectives.find((x) => x.id === 'cp' + k);
        v.style(COLOR.cp, o && o.enabled ? (this.selected === 'cp' + k ? 1 : 0.7) : 0.25, 0, show && this.showing());
      }));
      this.track.finBoxes.forEach((b, j) => {
        const id = 'fin:' + j;
        seen.add(id);
        let v = this.views.get(id);
        if (!v) { v = new BoxView(this.T, this.scene, false); v.set(b); this.views.set(id, v); }
        const o = this.model.objectives.find((x) => x.id === 'fin');
        v.style(COLOR.fin, o && o.enabled ? (this.selected === 'fin' ? 1 : 0.7) : 0.25, 0, show && this.showing());
      });
      for (const [id, v] of this.views) if (!seen.has(id)) { v.dispose(); this.views.delete(id); }
    },

    /** The watched car's own hitbox, where it is shown now (while the window is open). */
    syncCarView() {
      if (!this.T) return;
      const show = this.model.settings.showBoxes && this.showing();
      if (!show) { if (this.carView) this.carView.style(COLOR.car, 0, 0, false); return; }
      if (!this.carView) this.carView = new BoxView(this.T, this.scene, false);
      const entry = this.api.cars()[this.api.focus()];
      const st = entry.replay.getFrame(entry.car.getTime().numberOfFrames);
      if (!st) return;
      this.carView.set(K.carBox(st.position.x, st.position.y, st.position.z, st.quaternion.x, st.quaternion.y, st.quaternion.z, st.quaternion.w));
      this.carView.style(COLOR.car, 0.85, 0, true);
    },

    /** The window and the check time on the game's time bar (while the bruteforce window is open, or a run goes on). */
    paintMark() {
      const hud = this.api.hud(), bar = hud && hud.querySelector('.time-bar-ui > .bar');
      const inner = bar && (bar.firstElementChild || bar);
      if (!inner) return;
      if (!this.mark || !this.mark.isConnected) {
        if (getComputedStyle(inner).position === 'static') inner.style.position = 'relative';
        this.mark = document.createElement('div'); this.mark.className = 'tas-brute-mark';
        this.mark.innerHTML = '<i></i>';
        inner.appendChild(this.mark);
      }
      const s = this.model.settings, total = this.api.cars()[this.api.focus()].settings.time.numberOfFrames;
      const on = (this.showing() || (this.run && !this.run.finished)) && total > 0;
      this.mark.style.display = on ? '' : 'none';
      if (!on) return;
      const S = this.run ? this.run.S : s.S, E = this.run ? this.run.E : s.E, C = this.run ? this.run.C : Math.max(s.C, s.E + 1);
      const L = Math.max(0, Math.min(1, S / total)), R = Math.max(L, Math.min(1, (E + 1) / total)), X = Math.max(0, Math.min(1, C / total));
      this.mark.style.left = (L * 100).toFixed(3) + '%';
      this.mark.style.width = ((R - L) * 100).toFixed(3) + '%';
      this.mark.firstChild.style.left = (R - L > 0 ? ((X - L) / (R - L)) * 100 : 0).toFixed(3) + '%';
    },

    hudLine() {
      const r = this.run;
      if (!r) return null;
      const info = this.runInfo();
      const best = r.best ? this.short(r.best.score) : '—';
      return (r.finished ? 'Bruteforce done: ' : 'Bruteforce: ') + info.tries.toLocaleString('en-US') + (info.tries === 1 ? ' try' : ' tries') + (r.finished ? '' : ' · ' + Math.round(info.rate).toLocaleString('en-US') + '/s') + ' · best ' + best;
    },

    // ================================================================ the run
    /** What a score says, as the window writes it (speed to the speedometer's decimal places). */
    describe(s, run) {
      const dec = this.decimals(), parts = [];
      const kmh = s.V.toFixed(dec) + ' km/h';
      const name = (g) => (run.groups[g] ? run.groups[g].name : '?');
      if (!s.clean) parts.push('into ' + (run.nogos[s.touch] ? run.nogos[s.touch].name : 'a no-go') + ' at ' + secs(s.touchT));
      if (s.n === 0) parts.push(kmh);
      else if (s.hits === s.n) { parts.push(s.hits + '/' + s.n, name(s.n - 1) + ' at ' + secs(s.T), kmh); }
      else if (s.hits === 0) { parts.push(s.gap.toFixed(3) + ' m from ' + name(0), kmh); }
      else { parts.push(s.hits + '/' + s.n, name(s.hits - 1) + ' at ' + secs(s.T), s.gap.toFixed(3) + ' m from ' + name(s.hits), kmh); }
      return parts.join('  ·  ');
    },
    short(s) { return s.n && s.hits === s.n ? secs(s.T) + ' (' + s.V.toFixed(this.decimals()) + ' km/h)' : s.hits + '/' + s.n + ' ' + s.V.toFixed(this.decimals()) + ' km/h'; },

    start() {
      if (!this.api || !this.model) return;
      if (this.run && !this.run.finished) return;
      const s = this.model.settings, k = this.api.focus();
      const fail = (why) => { this.send({ type: 'log', text: why, cls: 'bad' }); this.tas.toast(why, 3000); };
      let inputs;
      try { inputs = this.inputsOf(s); } catch (e) { fail('Inputs: ' + e.message); return; }
      const text = this.tas.appliedText(k);
      const built = this.tas.build(text, 0);
      if (built.errors) { fail('The car\'s inputs have an error on line ' + built.errors[0].line); return; }
      const S = s.S, E = Math.max(s.E, S), C = Math.max(s.C, E + 1);
      if (C !== s.C) { s.C = C; this.saveModel(); }
      const groups = this.groups(), nogos = this.nogos();
      const exhaustive = s.search === 'exhaustive';
      const ctx = K.mutationContext({ inputs, S, E, changes: built.changes, weights: s.weights, insert: s.insert, shift: s.shift, per: s.per });
      if (!exhaustive && !ctx.types.length) { fail('Nothing to change: list an input with at least one change type ticked, and a weight above 0'); return; }
      // the exhaustive search: every pattern, however many (it goes until it is done or you stop it)
      let count = null;
      if (exhaustive) {
        count = K.patternCount(K.exhaustiveVariables(ctx, K.statesOf(built.changes, S, E)));
        if (count.big <= 1n) { fail('Nothing to try: list an input that differs from the run, with times inside the window'); return; }
      }
      const total = count ? count.total : null;
      const P = exhaustive ? 1 : s.populations;
      const T = Math.max(1, Math.min(MAX_THREADS, s.threads || autoThreads(), exhaustive ? total : Infinity));
      // each thread one block of the patterns, in order
      const blocks = exhaustive ? K.patternBlocks(count.big, T) : null;
      const G = window.__tasGame;
      const id = Date.now() % 1e9;
      // populations over threads: thread j works on population j mod P (more threads than populations: several per population)
      const assign = [];
      for (let j = 0; j < T; j++) assign.push([]);
      if (T >= P) for (let j = 0; j < T; j++) assign[j].push(j % P);
      else for (let p = 0; p < P; p++) assign[p % T].push(p);
      const share = (p) => { const ths = assign.map((a, j) => (a.includes(p) ? j : -1)).filter((j) => j >= 0); return ths; };
      const run = {
        id, k, car: this.carOf(k), S, E, C, base: built.changes, baseText: text, search: s.search, total, bits: count ? count.bits : 0, t0: performance.now(), finished: false,
        groups, nogos, alpha: s.alpha / 100, scoreMode: s.scoreMode, speed: s.speed,
        pops: [], threads: [], best: null, baseScore: null, vref: null, n: 0, pendingLive: null,
      };
      for (let p = 0; p < P; p++) run.pops.push({ id: p, score: null, win: null });
      const rec = new window.__tasRecording(I.toChannels(built.changes));
      const msgBase = {
        __tas: 'brute', id, base: built.changes, channels: I.toChannels(built.changes), S, E, C,
        groups: groups.map((g) => ({ name: g.name, members: g.members })), nogos, cpBoxes: this.track.cpBoxes, finBoxes: this.track.finBoxes,
        alpha: run.alpha, scoreMode: s.scoreMode, speed: s.speed, inputs, weights: s.weights, insert: s.insert, shift: s.shift, per: s.per, search: s.search,
        check: !!this.testCheck,             // tests: every restore compared with the whole memory
      };
      for (let j = 0; j < T; j++) {
        // a worker named "tas-brute" loads the physics that notes the pages it writes (tas-brute-physics.js)
        let sim;
        window.__tasWorkerName = 'tas-brute';
        try { sim = new G.SimulationWorker(false, G.trackParts, G.loader); } finally { window.__tasWorkerName = null; }
        const worker = sim.__tasWorker();
        const th = { j, sim, worker, pops: assign[j], tries: 0, frames: 0, busy: 0, repeats: 0, popTries: {}, ready: false, done: false };
        th.onMessage = (ev) => { const d = ev.data; if (d && d.__tas && d.id === id) this.threadMessage(run, th, d); };
        worker.addEventListener('message', th.onMessage);
        const d = this.api.spawn(sim, rec, () => {});
        th.carId = d.id;
        const pops = assign[j].map((p) => {
          const ths = share(p), idx = ths.indexOf(j), it = exhaustive ? 0 : s.iterations;      // (Iterations is the random search's)
          return { id: p, budget: it > 0 ? Math.floor(it / ths.length) + (idx < it % ths.length ? 1 : 0) : 0 };
        });
        worker.postMessage(Object.assign({}, msgBase, {
          carId: d.id, start: { p: [d.carState.position.x, d.carState.position.y, d.carState.position.z], q: [d.carState.quaternion.x, d.carState.quaternion.y, d.carState.quaternion.z, d.carState.quaternion.w] },
          // (a block's ends as text: BigInts of any size)
          pops, seed: (id * 7919 + j * 104729) >>> 0, from: blocks ? String(blocks[j][0]) : '0', to: blocks ? String(blocks[j][1]) : '0',
        }));
        run.threads.push(th);
      }
      this.run = run;
      this.results = [];
      this.verify = null;
      this.logRun = run;
      this.send({ type: 'started', k, S, E, C, threads: T, pops: P, search: s.search, total, bits: run.bits, speed: s.speed, carName: this.tas.session.cars[k].name });
      this.sendState();
      log('started on', this.tas.session.cars[k].name, '| window', S, '-', E, 'check', C, '|', P, 'populations on', T, 'threads', exhaustive ? '| exhaustive, ' + (count.bits > 50 ? 'about 2^' + Math.round(count.bits) : String(count.big)) + ' patterns' : '', s.speed === 'signed' ? '| signed speed' : '');
    },

    threadMessage(run, th, d) {
      if (run !== this.run && run !== this.lastRun) return;
      switch (d.__tas) {
        case 'brute-ready': {
          th.ready = true;
          if (!run.baseScore) {
            run.baseScore = d.base; run.vref = d.vref; run.before = d.before;
            for (const p of run.pops) { p.score = d.base; p.win = null; }
            this.addResult(run, { pop: null, score: d.base, win: null, tries: 0, start: true });
            log('ready: the run up to the start time in', Math.round(d.ms), 'ms; physics memory', (d.heap / 1048576).toFixed(1), 'MB; base', this.describe(d.base, run));
          } else if (JSON.stringify(d.base) !== JSON.stringify(run.baseScore)) {
            // every thread simulates the run on its own: they must agree to the last digit
            this.send({ type: 'log', text: 'Thread ' + (th.j + 1) + ' scored the starting run differently — please report this (a desync)', cls: 'bad' });
            console.error('[tas] bruteforce: threads disagree on the base run', d.base, run.baseScore);
          }
          break;
        }
        case 'brute-found': {
          const p = run.pops[d.pop];
          if (!p || !K.better(d.score, p.score)) break;
          p.score = d.score; p.win = d.win;
          for (const o of run.threads) if (o !== th && o.pops.includes(d.pop) && !o.done) o.worker.postMessage({ __tas: 'brute-best', id: run.id, pop: d.pop, win: d.win, score: d.score });
          // how far the whole run had got (every thread's last count, this one's now)
          th.popTries[d.pop] = Math.max(th.popTries[d.pop] || 0, d.tries);
          const tries = run.threads.reduce((s, o) => s + Math.max(o.tries, Object.values(o.popTries).reduce((a, b) => a + b, 0)), 0);
          this.addResult(run, { pop: d.pop, score: d.score, win: d.win, tries });
          break;
        }
        case 'brute-progress':
          th.tries = d.tries; th.frames = d.frames; th.busy = d.busy; th.repeats = d.repeats; th.restore = d.restore;
          for (const k of ['skipped', 'keeps', 'saved', 'heap', 'fulls', 'traps', 'lastTrap', 'mismatches', 'checked', 'badPages']) th[k] = d[k];
          for (const [pid, n] of d.pops) th.popTries[pid] = n;
          this.progress(run);
          break;
        case 'brute-done':
        case 'brute-stopped':
          th.done = true;
          if (run.threads.every((o) => o.done)) this.finish(run, d.__tas === 'brute-done' && !run.stopping);
          break;
        case 'brute-error':
        case 'error':
          th.done = true; th.error = String(d.message);
          this.send({ type: 'log', text: 'Thread ' + (th.j + 1) + ' failed: ' + d.message, cls: 'bad' });
          console.error('[tas] bruteforce thread', th.j, d.message);
          if (run.threads.every((o) => o.done)) this.finish(run, false);
          break;
      }
    },

    addResult(run, r) {
      const n = run.n++;
      const overall = r.start || !run.best || K.better(r.score, run.best.score);
      const res = { n, pop: r.pop, score: r.score, win: r.win, tries: r.tries, at: performance.now() - run.t0, overall: !!overall && !r.start, start: !!r.start };
      if (overall && !r.start) run.best = res;
      if (r.start) run.best = res;
      res.line = {
        n, pop: r.pop, overall: res.overall, start: res.start, clean: r.score.clean, tries: r.tries, at: res.at,
        text: this.describe(r.score, run), hits: r.score.hits, of: r.score.n,
      };
      this.results.push(res);
      this.send({ type: 'result', line: res.line });
      // (a best found just after you left the track, while the run stops, only goes on the list)
      if (res.overall && this.model && this.model.settings.live) this.scheduleLive(run, res);
    },

    progress(run) {
      const now = performance.now();
      if (now - (run.lastProgress || 0) < 200) return;
      run.lastProgress = now;
      this.send({ type: 'progress', run: this.runInfo() });
      if (this.tas) this.tas.hudKey = '';
    },

    stop(quiet) {
      const run = this.run;
      if (!run || run.finished) return;
      run.stopping = true;
      for (const th of run.threads) if (!th.done) th.worker.postMessage({ __tas: 'brute-stop', id: run.id });
      // a worker that does not answer (busy simulating to the start time) goes anyway
      setTimeout(() => { if (!run.finished) this.finish(run, false); }, quiet ? 0 : 1500);
    },

    finish(run, complete) {
      if (run.finished) return;
      run.finished = true;
      // the last overall best still waiting to go on the car goes now
      if (run.liveTimer) { clearTimeout(run.liveTimer); run.liveTimer = null; const r = run.pendingLive; run.pendingLive = null; if (r) this.show(run, r); }
      for (const th of run.threads) { th.worker.removeEventListener('message', th.onMessage); try { th.sim.dispose(); } catch { } }
      const info = this.runInfo();
      if (this.run === run) { this.lastRun = run; }
      this.send({ type: 'finished', complete, run: info });
      log(complete ? 'done' : 'stopped', 'after', info.tries, 'tries in', (info.elapsed / 1000).toFixed(1), 's', '(' + Math.round(info.rate) + '/s, ' + info.msPerTry.toFixed(2) + ' ms a try)');
      this.sendState();
      if (this.tas) this.tas.hudKey = '';
    },

    /** The inputs of a result, as text: the run's own with the window replaced. */
    resultText(run, res) {
      if (!res.win) return run.baseText;
      return I.toText(K.assemble(run.base, run.S, run.E, res.win));
    },

    scheduleLive(run, res) {
      run.pendingLive = res;
      if (run.liveTimer) return;
      run.liveTimer = setTimeout(() => { run.liveTimer = null; const r = run.pendingLive; run.pendingLive = null; if (r) this.show(run, r); }, 250);
    },

    applyResult(n) {
      const run = this.run || this.lastRun;
      if (!run) return;
      const res = n === 'best' ? run.best : this.results.find((r) => r.n === n);
      if (!res) return;
      if (run.k == null) {
        const why = 'The car these inputs were found for (' + run.car.name + ') is not in this Replay Editor';
        this.send({ type: 'log', text: why, cls: 'bad' });
        if (this.tas) this.tas.toast(why, 3000);
        return;
      }
      // what you picked stays on the car (an overall best still waiting to go on does not replace it)
      if (run.liveTimer) { clearTimeout(run.liveTimer); run.liveTimer = null; run.pendingLive = null; }
      this.show(run, res);
    },

    /** Puts a result on the car it was found for (as Apply does), then checks it once the car has run it. */
    show(run, res) {
      if (!this.tas || !this.tas.session) return;
      const text = this.resultText(run, res);
      this.tas.apply(run.k, text, run.C + 1);
      if (this.api.focus() === run.k) this.tas.sendLoad();
      this.verify = { n: res.n, pending: true };
      this.send({ type: 'verify', n: res.n, pending: true });
      const want = res.score;
      const check = () => {
        if (!this.tas || !this.tas.session || !this.verify || this.verify.n !== res.n) return;
        const entry = this.api.cars()[run.k];
        if (entry.__tasBusy || entry.carId != null) { setTimeout(check, 50); return; }
        const got = this.scoreFrames(run, entry);
        const ok = got && JSON.stringify(got) === JSON.stringify(want);
        this.verify = { n: res.n, ok, pending: false };
        this.send({ type: 'verify', n: res.n, ok, pending: false, detail: ok ? null : 'the Replay Editor gives ' + (got ? this.describe(got, run) : 'no run') });
        if (!ok) console.error('[tas] bruteforce: result', res.n, 'does not replay the same', want, got);
      };
      setTimeout(check, 30);
    },

    /** The score of a car's frames in the Replay Editor, worked out the way the bruteforce's workers do. */
    scoreFrames(run, entry) {
      const tr = new K.Tracker({ groups: run.groups.map((g) => ({ name: g.name, members: g.members })), nogos: run.nogos,
        S: run.S, C: run.C, alpha: run.alpha, mode: run.scoreMode, vref: run.vref, speed: run.speed, cpBoxes: this.track.cpBoxes, finBoxes: this.track.finBoxes });
      const s0 = entry.replay.getFrame(0);
      if (!s0) return null;
      tr.begin(s0.position.x, s0.position.y, s0.position.z, s0.quaternion.x, s0.quaternion.y, s0.quaternion.z, s0.quaternion.w, 0);
      for (let f = 1; f <= run.C; f++) {
        const st = entry.replay.getFrame(f);
        if (!st || st.frames !== f) return null;
        if (tr.frame(f, st.position.x, st.position.y, st.position.z, st.quaternion.x, st.quaternion.y, st.quaternion.z, st.quaternion.w, st.speedKmh, st.nextCheckpointIndex, st.finishFrames != null, f > run.S) && f > run.S) break;
      }
      return tr.result();
    },
  };

  // the time bar's mark for the window and the check time
  const css = document.createElement('style');
  css.textContent = '.time-bar-ui .tas-brute-mark { position:absolute; top:0; bottom:0; z-index:1; background-color:rgba(79, 195, 247, 0.22); border-left:2px solid #4fc3f7; box-sizing:border-box; pointer-events:none; }'
    + '.time-bar-ui .tas-brute-mark > i { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; background-color:#4fc3f7; }';
  (document.head || document.documentElement).appendChild(css);

  if (window.tasBridge && window.tasBridge.onBruteMessage) window.tasBridge.onBruteMessage((msg) => { try { Brute.fromWindow(msg); } catch (e) { console.error('[tas] bruteforce window message', e); } });
  window.TASBrute = Brute;
})();
