/*
 * PolyTrack TAS — the game side.
 *
 * The Replay Editor: under each track's leaderboard, "Replay Editor" opens the game's replay viewer with
 * a TAS car (watched first) and every run you selected on the leaderboard. Whichever car you watch is
 * the one you edit: the input editor window (the "Open the input editor" key, Q) shows its inputs, and
 * Apply in the editor runs that car again with the new inputs — on the game's own physics, from the
 * same start, exactly as the game would play them back.
 *
 *   - Each car keeps what you applied to it, and any edit you have not applied yet, while the Replay
 *     Editor is open; switching cars and back brings them back.
 *   - The cars you edit run in lanes (tas-lane.js): a physics worker each, with save points, so Apply
 *     only simulates again from the first millisecond you changed.
 *   - The TAS car's inputs are kept per track: Apply saves them, and the next Replay Editor on that
 *     track starts from them. Unapplied typing is kept too, as a draft.
 *   - Keys (Settings → Controls → TAS): next car, steps of 10 ms (Shift: 100 ms; the game's own step
 *     keys still step 1 ms), the ghost offset, slower / faster / normal speed, an A–B loop, telemetry.
 *     The speed and the loop also have buttons beside the play button, as in Tweaks' replay viewer.
 *   - Ghost offset: each car can be shown ahead of or behind the others, a millisecond at a time. The
 *     viewer's clock is the watched car's own time; every other car shows its frame at that time plus
 *     its offset minus the watched car's, so the car you watch stays put and the others move.
 *   - The speedometer has decimal places (Settings → Speedometer decimal places).
 *
 * The game's code hands this file what it needs (tools/patches.mjs): its Recording and Time classes,
 * the settings and key bindings, the viewer (window.__tasOpenEditor / __tasApi()), and the track page.
 */
(function () {
  'use strict';

  const I = window.TASInputs;
  const STORE = 'tas-v1:';                 // + track id → the TAS car's applied inputs
  const DRAFT = 'tas-v1-draft:';           // + track id → typed but not applied yet
  const PREFS = 'tas-v1-prefs';
  const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4];
  const MAX_LANES = 4;                     // workers kept for edited cars (the TAS car's is always kept)
  const log = (...a) => console.log('[tas]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (ms) => {
    if (ms == null || !isFinite(ms)) return '—';
    const neg = ms < 0; ms = Math.abs(Math.round(ms));
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return (neg ? '−' : '') + (m ? m + ':' + String(s).padStart(2, '0') : String(s)) + '.' + String(r).padStart(3, '0');
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { log('could not save', k, e); } },
  };

  const CSS = `
/* the leaderboard's bottom row: left of "Only verified", the same size (the row is 600px; it fits) */
.leaderboard-ui > .button-wrapper > .button.tas-open { margin:10px 10px 10px 0; float:right; font-size:20px; line-height:32px; }
.leaderboard-ui > .button-wrapper > .button.tas-open > img { margin:0 6px -5px 0; width:24px; height:24px; }
.leaderboard-ui > .button-wrapper > .button.tas-open.busy { opacity:0.6; pointer-events:none; }
/* the editor's panel: a box at the left edge, like the game's HUD boxes */
.tas-hud { position:absolute; left:var(--safe-area-horizontal, 0); top:120px; z-index:2; min-width:300px; max-width:420px; padding:8px 12px 10px;
  color:var(--text-color); background-color:var(--surface-color); opacity:0.94; pointer-events:none; line-height:1.3;
  clip-path:polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.tas-hud .t { font-size:15px; opacity:0.6; letter-spacing:0.04em; }
.tas-hud .car { margin-top:2px; font-size:24px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tas-hud .car small { font-size:15px; opacity:0.6; margin-left:8px; }
.tas-hud .mod { color:#ff5; }
.tas-hud .car small.mod { opacity:1; }
.tas-hud .row { margin-top:4px; font-size:16px; }
.tas-hud .row.small { font-size:14px; }
.tas-hud .dim { opacity:0.6; }
.tas-hud .good { color:#5f5; }
.tas-hud .bad { color:#f55; }
.tas-hud .key { display:inline-block; min-width:1.4em; margin-right:4px; padding:0 0.35em; text-align:center; font-style:normal; background-color:var(--button-color); border-radius:4px; }
.tas-hud .bar { height:4px; margin-top:6px; background-color:var(--surface-tertiary-color); }
.tas-hud .bar > i { display:block; height:100%; width:0; background-color:hsl(210, 100%, 65%); }
.tas-toast { position:absolute; left:50%; bottom:150px; z-index:60; padding:8px 22px; font-size:22px; color:var(--text-color);
  background-color:var(--surface-color); transform:translateX(-50%); pointer-events:none; opacity:0; transition:opacity 0.15s ease-out;
  clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.tas-toast.show { opacity:0.95; }
/* the loop, marked on the viewer's timeline */
.time-bar-ui .tas-range { position:absolute; top:0; bottom:0; z-index:1; background-color:rgba(255, 255, 85, 0.22);
  border-left:2px solid #ff5; border-right:2px solid #ff5; box-sizing:border-box; pointer-events:none; }
.time-bar-ui .tas-range.open { border-right:none; background-color:transparent; }
.time-bar-ui .tas-range.off { opacity:0.4; }
.time-bar-ui .tas-range.hide { display:none; }
/* the speed and the loop, beside the play button: buttons like the bar's own (from Tweaks' replay tools) */
.time-bar-ui > .tas-rt { display:flex; flex-shrink:0; }
.time-bar-ui > .tas-rt > .button { display:flex; align-items:center; justify-content:center; box-sizing:border-box; min-width:64px; height:calc(100% - 12px);
  margin:6px 6px 6px 0; padding:0 12px; font-size:22px; white-space:nowrap; }
.time-bar-ui > .tas-rt > .button.on { background-color:var(--button-hover-color); }
.time-bar-ui > .tas-rt > .button.slow { color:#ff5; }
/* a number in the game's Settings (the speedometer's decimal places) */
.settings-menu-ui > .container > .setting > input.tas-setting-text { margin:0 0 0 20px; width:150px; height:48px; padding:0 12px; border:none; outline:none;
  font-family:inherit; font-size:28px; text-align:center; color:var(--text-color); background-color:var(--button-color);
  clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); pointer-events:auto; }
.settings-menu-ui > .container > .setting > input.tas-setting-text:focus { background-color:var(--button-hover-color); }
.settings-menu-ui > .container > .setting > input.tas-setting-text.bad { box-shadow:inset 0 0 0 2px #f55; }
`;

  const TAS = {
    viewer: null, api: null, session: null, pending: null, raf: 0, prefs: null, lanes: new Map(),
    speed: 1, loopA: null, loopB: null, loopOn: false,
    editorOpen: false, lastSentTime: -1, lastSentAt: 0,

    init() {
      const st = el('style'); st.id = 'tas-css'; st.textContent = CSS; document.head.appendChild(st);
      try { this.prefs = Object.assign({ tail: 5000, telemetry: true, lines: true }, JSON.parse(store.get(PREFS) || '{}')); } catch { this.prefs = { tail: 5000, telemetry: true, lines: true }; }
      if (window.tasBridge) window.tasBridge.onMessage((msg) => { try { this.fromEditor(msg); } catch (e) { console.error('[tas] editor message', e); } });
    },
    savePrefs() { store.set(PREFS, JSON.stringify(this.prefs)); },

    game() { return window.__tasGame || null; },
    keyIs(e, name) {
      const g = this.game(), E = window.__tasKeyEnum;
      return !!(g && E && E[name] != null && g.settings.checkKeyBinding(e, E[name]));
    },
    keyLabel(name) {
      const g = this.game(), E = window.__tasKeyEnum;
      if (!g || !E) return '?';
      const codes = (g.settings.getKeyBindings(E[name]) || []).filter(Boolean);
      return codes.length ? codes.map((c) => (window.__tasKeyName ? window.__tasKeyName(c) : c)).join(' / ') : '—';
    },
    toast(text, ms) {
      let t = document.querySelector('.tas-toast');
      if (!t) { t = el('div', 'tas-toast'); (document.getElementById('ui') || document.body).appendChild(t); }
      t.textContent = text; t.classList.add('show');
      clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
    },

    /**
     * A row with a number in the game's Settings, drawn as its rows are (called from the settings screen:
     * the speedometer's decimal places). Whole numbers min–max; anything else is outlined and ignored.
     */
    settingText(box, label, value, min, max, commit) {
      const row = el('div', 'setting');
      row.appendChild(el('p', null, label + ' (' + min + '–' + max + ')'));
      const input = el('input', 'tas-setting-text');
      input.type = 'text'; input.inputMode = 'numeric'; input.spellcheck = false;
      let shown = String(value);
      input.value = shown;
      const set = () => {
        const t = input.value.trim();
        if (!/^\d+$/.test(t)) { input.classList.add('bad'); return; }
        const v = Math.max(min, Math.min(max, parseInt(t, 10)));
        input.classList.remove('bad');
        input.value = String(v);
        if (String(v) !== shown) { shown = String(v); commit(shown); }
      };
      input.addEventListener('change', set);
      input.addEventListener('blur', set);
      // the game's own keys stay out of the box (Escape still closes the menu)
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { set(); input.blur(); e.preventDefault(); } if (e.key !== 'Escape') e.stopPropagation(); });
      input.addEventListener('keyup', (e) => e.stopPropagation());
      row.appendChild(input);
      box.appendChild(row);
    },

    // ---------------------------------------------------------------- runs and recordings
    /** Inputs text → the game's Recording, and how long to simulate it. */
    build(text, minLen) {
      const p = I.parse(text);
      const errors = p.problems.filter((x) => x.level === 'error');
      if (errors.length) return { errors };
      const changes = I.expand(p.items);
      const rec = new window.__tasRecording(I.toChannels(changes));
      const len = Math.max(minLen || 0, I.lastTick(changes) + this.prefs.tail);
      return { rec, changes, len };
    },
    /** A Recording → its inputs as text (exact: read from its own key lists). */
    textOf(recording) { return I.toText(I.fromChannels(window.__tasChannelsOf(recording))); },

    // ---------------------------------------------------------------- the track page
    trackPage(ctx) {
      this.ctx = ctx;
      try {
        const row = ctx.root.querySelector('.leaderboard-ui > .button-wrapper');
        if (!row || row.querySelector('.tas-open')) return;
        const b = el('button', 'button tas-open');
        const img = el('img'); img.src = 'images/editor.svg';
        b.append(img, 'Replay Editor');
        b.title = 'Watch and edit runs: a TAS car plus the runs you selected on the leaderboard';
        b.addEventListener('click', () => this.open(ctx, b));
        row.appendChild(b);
      } catch (e) { console.error('[tas] track page', e); }
    },

    async open(ctx, button) {
      if (this.opening || !window.__tasOpenEditor) return;
      this.opening = true;
      if (button) button.classList.add('busy');
      try {
        const selected = ctx.selected() || [];
        const trackData = typeof ctx.trackData === 'function' ? await ctx.trackData() : ctx.trackData;
        let runs = [];
        if (selected.length) {
          this.toast('Loading ' + selected.length + (selected.length === 1 ? ' run…' : ' runs…'));
          const got = await ctx.api.getRecordings(selected.map((e) => e.recordingId));
          if (!got || got.some((g) => g == null)) throw new Error('a selected run could not be downloaded');
          runs = got.map((g, i) => ({ recording: g.recording, carStyle: g.carStyle, nickname: selected[i].nickname, time: g.time, isSelf: !!selected[i].isSelf }));
        }
        const profile = ctx.profiles.getCurrentUserProfile();
        let applied = store.get(STORE + ctx.trackId) || '';
        let draft = store.get(DRAFT + ctx.trackId);
        let built = this.build(applied, 0);
        if (built.errors) {
          // never lose a TAS: one that no longer reads is kept as unapplied text, with its problems marked
          log('the saved TAS for this track does not parse; it is kept as unapplied text');
          if (draft == null) draft = applied;
          applied = '';
          built = this.build('', 0);
        }
        const tas = { recording: built.rec, carStyle: profile.carStyle, nickname: 'TAS', time: new window.__tasTime(built.len), isSelf: false };
        this.pending = { trackId: ctx.trackId, trackName: (ctx.metadata && ctx.metadata.name) || 'Track', applied, draft: draft != null && draft !== applied ? draft : null, built };
        window.__tasOpenEditor(ctx.metadata, trackData, ctx.type, [tas].concat(runs), { trackId: ctx.trackId });
      } catch (e) {
        console.error('[tas] open', e);
        this.toast('Could not open the Replay Editor: ' + ((e && e.message) || e), 4000);
      } finally {
        this.opening = false;
        if (button) button.classList.remove('busy');
      }
    },

    // ---------------------------------------------------------------- the viewer, in editor mode
    viewerCreated(viewer) {
      if (!viewer.__tasEd || !this.pending) return;
      const p = this.pending;
      this.pending = null;
      this.viewer = viewer;
      this.api = viewer.__tasApi();
      const cars = this.api.cars();
      this.session = {
        trackId: p.trackId, trackName: p.trackName,
        cars: cars.map((c, k) => ({
          name: k === 0 ? 'TAS' : (c.settings.nickname || 'Run ' + k), kind: k === 0 ? 'tas' : 'run',
          original: k === 0 ? null : undefined,          // a run's own inputs, read when first needed
          applied: k === 0 ? p.applied : undefined,      // what the car is driving now
          draft: k === 0 ? p.draft : null,               // typed in the editor, not applied
          origLen: c.settings.time.numberOfFrames,
          pendingReply: false, lastApply: null,
        })),
      };
      this.speed = 1; this.loopA = this.loopB = null; this.loopOn = false;
      for (const c of cars) c.__tasOff = 0;
      this.lastFocus = this.api.focus();
      const toast = document.querySelector('.tas-toast');
      if (toast) { clearTimeout(this.toastTimer); toast.classList.remove('show'); }
      this.buildHud();
      const tick = () => { this.raf = requestAnimationFrame(tick); try { this.frame(); } catch (e) { if (!this.warned) { this.warned = true; console.error('[tas]', e); } } };
      this.raf = requestAnimationFrame(tick);
      // the TAS car runs in its own lane from the start, so even the first Apply resumes from a save point
      this.laneFor(0).run(p.built.rec, I.toChannels(p.built.changes), p.built.changes, p.built.len);
      if (window.TASTelemetry) { window.TASTelemetry.on = () => this.prefs.telemetry !== false; window.TASTelemetry.attach(this.api); }
      if (window.TASLines) {
        const L = window.TASLines, setting = (name, def) => { try { const v = parseInt(this.api.settings().getSetting(this.api.settingEnum()[name]), 10); return isFinite(v) ? v : def; } catch { return def; } };
        L.on = () => this.prefs.lines !== false;
        L.step = () => setting('TASRacingLineStep', 1);
        L.size = () => setting('TASRacingLineSize', 3);
        L.attach(this.api);
      }
      if (window.TASBrute) window.TASBrute.attach(this);
      // an input editor still open from before shows this Replay Editor's cars, and the TAS car's inputs
      this.sendState(true);
      this.sendLoad();
      log('Replay Editor on', p.trackName, 'with', cars.length, 'cars');
    },

    /** Car k's lane, made if it has none (the least recently used idle one goes past MAX_LANES; never the TAS car's). */
    laneFor(k) {
      let lane = this.lanes.get(k);
      if (lane) return lane;
      if (this.lanes.size >= MAX_LANES) {
        const idle = [...this.lanes.values()].filter((l) => l.k !== 0 && !l.busy()).sort((a, b) => a.usedAt - b.usedAt)[0];
        if (idle) { idle.dispose(); this.lanes.delete(idle.k); }
      }
      lane = new window.TASLane(this.api, k, { done: (l, st) => this.laneDone(l, st), error: (l, msg) => this.laneError(l, msg) });
      this.lanes.set(k, lane);
      return lane;
    },

    laneDone(lane, st) {
      if (!this.session) return;
      const s = this.session.cars[lane.k];
      s.lastApply = st;
      if (s.pendingReply) {
        s.pendingReply = false;
        this.reply({ type: 'applied', index: lane.k, ok: true, ms: Math.round(st.wall), from: st.from, simulated: st.simulated, finish: this.finishOf(lane.k), length: st.frames });
      }
      this.hudKey = '';
      this.sendState();
    },

    laneError(lane, message) {
      if (!this.session) return;
      const s = this.session.cars[lane.k];
      if (s.pendingReply) { s.pendingReply = false; this.reply({ type: 'applied', index: lane.k, ok: false, error: 'the simulation failed: ' + message }); }
      this.toast('Simulation failed: ' + message, 4000);
      // a lane that failed is not used again; the next Apply on this car starts a new one
      lane.dispose();
      this.lanes.delete(lane.k);
    },

    viewerDisposed(viewer) {
      if (viewer !== this.viewer) return;
      if (window.TASTelemetry) window.TASTelemetry.detach();
      if (window.TASLines) window.TASLines.detach();
      if (window.TASBrute) window.TASBrute.detach();
      for (const lane of this.lanes.values()) lane.dispose();
      this.lanes.clear();
      cancelAnimationFrame(this.raf);
      if (this.hud) this.hud.remove();
      if (this.range) this.range.remove();
      if (this.rt) this.rt.group.remove();
      this.hud = this.range = this.rt = null;
      this.viewer = this.api = null;
      this.session = null;
      if (window.tasBridge) window.tasBridge.send({ type: 'detached' });
    },

    focusChanged(viewer) {
      if (viewer !== this.viewer) return;
      // the clock is the watched car's own time: with offsets, keep every car where it was on screen
      const cars = this.api.cars(), was = cars[this.lastFocus], now = cars[this.api.focus()];
      const d = ((now && now.__tasOff) || 0) - ((was && was.__tasOff) || 0);
      this.lastFocus = this.api.focus();
      if (d) {
        this.api.seek(this.api.time() + d / 1000);
        if (this.loopA != null) this.loopA += d / 1000;
        if (this.loopB != null) this.loopB += d / 1000;
        this.api.redraw();
      }
      this.layout();
      this.hudKey = '';
      this.paintHud();
      this.sendLoad();
      this.sendState();
      if (window.TASBrute) window.TASBrute.sendState();
    },

    // ---------------------------------------------------------------- the ghost offset
    // Each car has an offset in ms (+ ahead, − behind). The viewer's clock is the watched car's own time;
    // car k shows its frame at clock + (its offset − the watched car's), from its first frame (it waits at
    // the start) to its last (a finished run stays where it ended).
    rel(entry) { return (entry.__tasOff || 0) - (this.api.cars()[this.api.focus()].__tasOff || 0); },
    /** Called by the viewer for every car and frame it shows. */
    frameFor(viewer, entry, e) {
      if (viewer !== this.viewer || !this.api) return e;
      let f = e + this.rel(entry);
      if (f < 0) f = 0;
      else if (entry.carId == null && !entry.__tasBusy) { const last = entry.replay.getLastFrame().numberOfFrames; if (f > last) f = last; }
      return f;
    },
    /** How far car `entry` is shown ahead of the watched car (the viewer waits for frames that far on). */
    relOf(viewer, entry) { return viewer === this.viewer && this.api ? this.rel(entry) : 0; },
    /** The watched car's offset, in ms. */
    offset() { return this.api ? this.api.cars()[this.api.focus()].__tasOff || 0 : 0; },
    setOffset(ms) {
      if (!this.api) return;
      this.api.cars()[this.api.focus()].__tasOff = Math.round(ms);
      this.layout();
      this.api.redraw();
      this.hudKey = '';
    },
    /** No offsets at all (the \ key). */
    clearOffsets() {
      if (!this.api) return;
      for (const c of this.api.cars()) c.__tasOff = 0;
      this.layout();
      this.api.redraw();
      this.hudKey = '';
    },
    /**
     * Every other car's offset set so that it crosses the last checkpoint the watched car has passed (the
     * first one, before any) at the same moment as the watched car: car k shows clock + off[k] − off[watched],
     * so with the clock at the watched car's checkpoint frame F, car k shows its own checkpoint frame K when
     * off[k] = off[watched] + K − F. A car that never reached that checkpoint keeps its offset.
     */
    alignAtCheckpoint() {
      if (!this.api) return;
      const cars = this.api.cars(), f = this.api.focus(), me = cars[f];
      const now = Math.round(this.api.time() * 1000);
      const mine = me.checkpointTimes.map((t) => t.numberOfFrames);
      if (!mine.length) { this.toast(this.session.cars[f].name + ' has not passed a checkpoint', 1500); return; }
      let c = 0;
      for (let i = 0; i < mine.length; i++) if (mine[i] <= now) c = i;
      let n = 0;
      cars.forEach((e, k) => {
        const t = e.checkpointTimes[c];
        if (k === f || !t) return;
        e.__tasOff = (me.__tasOff || 0) + t.numberOfFrames - mine[c];
        n++;
      });
      this.layout();
      this.api.redraw();
      this.hudKey = '';
      this.toast(n ? 'Aligned at checkpoint ' + (c + 1) : 'No other car reached checkpoint ' + (c + 1), 1400);
    },
    /** How far each other car is from the watched one, in ms (− : the watched car behind it). */
    offsetsVsOthers() {
      const cars = this.api.cars(), f = this.api.focus(), out = [];
      cars.forEach((c, k) => { if (k !== f) out.push({ k, name: this.session.cars[k].name, ms: -this.rel(c) }); });
      return out;
    },
    /** The viewer's length on the watched car's clock: every car's run, as offset, and the game's 10 s after. */
    layout() {
      if (!this.api) return;
      let end = 0;
      for (const c of this.api.cars()) end = Math.max(end, c.settings.time.numberOfFrames - this.rel(c));
      this.api.setDuration(end + 10000);
    },

    /** The text a car is driving now (a run's own inputs until it is changed). */
    appliedText(k) {
      const s = this.session.cars[k];
      if (s.applied === undefined) {
        const rec = this.api.cars()[k].settings.recording;
        s.original = this.textOf(rec);
        s.applied = s.original;
      }
      return s.applied;
    },
    modified(k) { const s = this.session.cars[k]; return s.kind === 'tas' ? false : s.applied !== undefined && s.applied !== s.original; },

    /** Car k drives these inputs (at least minLen ms of them: the bruteforce checks its results up to its check time). */
    apply(k, text, minLen) {
      if (!this.api || !this.session || k < 0 || k >= this.session.cars.length) return;
      const s = this.session.cars[k];
      const built = this.build(text, Math.max(minLen || 0, s.kind === 'tas' ? 0 : s.origLen));
      if (built.errors) {
        this.reply({ type: 'applied', index: k, ok: false, error: built.errors.map((e) => 'line ' + e.line + ': ' + e.message).join('\n') });
        return;
      }
      // the car drives the new inputs from the first millisecond they change (its lane resumes there)
      this.api.setRun(k, built.rec, new window.__tasTime(built.len));
      this.layout();
      this.laneFor(k).run(built.rec, I.toChannels(built.changes), built.changes, built.len);
      s.applied = text;
      s.draft = null;
      s.pendingReply = true;
      if (s.kind === 'tas') { store.set(STORE + this.session.trackId, text); store.set(DRAFT + this.session.trackId, null); }
      this.paintHud();
      this.sendState();
    },

    revert(k) {
      const s = this.session && this.session.cars[k];
      if (!s || s.kind === 'tas') return;
      this.appliedText(k);
      this.apply(k, s.original);
    },

    /** Simulation progress of car k: 0..1, and whether it is complete. */
    progress(k) {
      const c = this.api.cars()[k];
      const done = c.carId == null && !c.__tasBusy;
      if (done) return { done, frac: 1 };
      const lane = this.lanes.get(k);
      const target = lane && c.__tasBusy ? lane.target : Math.round(this.api.duration() * 1000);
      return { done, frac: Math.min(1, c.replay.getLastFrame().numberOfFrames / Math.max(1, target)) };
    },
    /** Where car k's run ends: its finish time in ms, or null if it does not finish. */
    finishOf(k) {
      const c = this.api.cars()[k];
      if (c.finishSpeed == null) return null;
      // every frame from the finish on carries it
      const st = c.replay.getFrame(c.replay.getLastFrame().numberOfFrames);
      return st && st.finishFrames != null ? st.finishFrames : null;
    },
    /** What car k's finish is measured against: a run's own time before it was edited; for the TAS car, the fastest selected run. */
    finishRef(k) {
      const s = this.session.cars[k];
      if (s.kind === 'run') return this.modified(k) ? { ms: s.origLen, label: 'the original' } : null;
      let best = null;
      for (const o of this.session.cars) if (o.kind === 'run' && (best == null || o.origLen < best.ms)) best = { ms: o.origLen, label: o.name };
      return best;
    },

    // ---------------------------------------------------------------- every frame
    frame() {
      if (!this.api) return;
      const k = this.api.focus();
      this.paintHud();
      this.paintBar();
      if (window.TASLines) window.TASLines.tick();
      if (window.TASBrute) window.TASBrute.tick();
      // the time, to the editor (at most ~30 times a second)
      if (this.editorOpen && window.tasBridge) {
        const t = Math.round(this.api.time() * 1000), now = performance.now();
        if (t !== this.lastSentTime && now - this.lastSentAt > 33) {
          this.lastSentTime = t; this.lastSentAt = now;
          let keys = 0;
          try { const c = this.api.cars()[k].car.getControls(); keys = (c.up ? 1 : 0) | (c.left ? 2 : 0) | (c.down ? 4 : 0) | (c.right ? 8 : 0) | (c.reset ? 16 : 0); } catch { }
          window.tasBridge.send({ type: 'time', t, keys, paused: this.api.paused(), index: k });
        }
      }
      // the time, to the bruteforce window (its "Now" buttons)
      const B = window.TASBrute;
      if (B && B.windowOpen && window.tasBridge && window.tasBridge.sendBrute) {
        const t = Math.round(this.api.time() * 1000), now = performance.now();
        if (t !== this.lastBruteTime && now - (this.lastBruteAt || 0) > 50) { this.lastBruteTime = t; this.lastBruteAt = now; window.tasBridge.sendBrute({ type: 'time', t, index: k }); }
      }
    },

    // ---------------------------------------------------------------- the panel
    buildHud() {
      const hud = this.api.hud();
      this.hud = el('div', 'tas-hud');
      hud.appendChild(this.hud);
      const bar = hud.querySelector('.time-bar-ui > .bar');
      const inner = bar && (bar.firstElementChild || bar);
      if (inner) {
        if (getComputedStyle(inner).position === 'static') inner.style.position = 'relative';
        this.range = el('div', 'tas-range hide');
        inner.appendChild(this.range);
      }
      // the speed and the loop beside the play button, as in Tweaks' replay viewer
      if (bar) {
        const group = el('div', 'tas-rt');
        const speed = el('button', 'button', '1×');
        speed.title = 'Playback speed: click for the next, right-click for the one before. Keys: '
          + [this.keyLabel('TASSlower'), this.keyLabel('TASFaster'), this.keyLabel('TASNormalSpeed')].join(' / ');
        speed.addEventListener('click', (e) => { e.stopPropagation(); this.stepSpeed(1, true); });
        speed.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.stepSpeed(-1, true); });
        const loop = el('button', 'button', 'A–B');
        loop.title = 'Loop a section: click once where it starts, again where it ends, again to stop. Keys: '
          + [this.keyLabel('TASLoopStart'), this.keyLabel('TASLoopEnd'), this.keyLabel('TASLoop')].join(' / ');
        loop.addEventListener('click', (e) => { e.stopPropagation(); this.cycleLoop(); });
        group.append(speed, loop);
        bar.parentElement.insertBefore(group, bar);
        this.rt = { group, speed, loop };
      }
      this.hudKey = '';
      this.paintHud();
    },

    paintHud() {
      if (!this.hud || !this.api) return;
      const k = this.api.focus(), n = this.session.cars.length, s = this.session.cars[k];
      const pr = this.progress(k);
      const fin = pr.done ? this.finishOf(k) : null;
      const offs = this.offsetsVsOthers();
      const brute = window.TASBrute ? window.TASBrute.hudLine() : null;
      const key = [k, n, s.name, this.modified(k), s.draft != null, pr.done, Math.round(pr.frac * 50), fin, this.speed, this.loopA, this.loopB, this.loopOn, this.editorOpen, offs.map((o) => o.ms).join(','), brute].join('|');
      if (key === this.hudKey) return;
      this.hudKey = key;
      const h = this.hud;
      h.textContent = '';
      h.appendChild(el('div', 't', 'REPLAY EDITOR'));
      const car = el('div', 'car', s.name);
      if (this.modified(k)) car.appendChild(el('small', 'mod', 'edited'));
      car.appendChild(el('small', null, (k + 1) + ' of ' + n));
      h.appendChild(car);
      const status = el('div', 'row');
      if (!pr.done) status.append('Simulating… ' + Math.round(pr.frac * 100) + ' %');
      else if (fin != null) {
        status.append('Finish ', el('span', 'good', fmt(fin)));
        const ref = this.finishRef(k);
        if (ref) {
          const d = fin - ref.ms;
          status.append('  ', el('span', d < 0 ? 'good' : d > 0 ? 'bad' : 'dim', (d > 0 ? '+' : d < 0 ? '' : '±') + fmt(d)), el('span', 'dim', ' vs ' + ref.label));
        }
      } else status.append(el('span', 'dim', 'Does not finish'));
      if (s.draft != null) status.append(el('span', 'dim', '  · unapplied edits'));
      h.appendChild(status);
      if (!pr.done) { const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (pr.frac * 100).toFixed(1) + '%'; bar.appendChild(fill); h.appendChild(bar); }
      if (brute) h.appendChild(el('div', 'row small mod', brute));
      const keys = el('div', 'row dim');
      keys.append(el('span', 'key', this.keyLabel('TASEditor')), this.editorOpen ? 'input editor (open)   ' : 'input editor   ');
      keys.append(el('span', 'key', this.keyLabel('TASBrute')), 'bruteforce   ');
      if (n > 1) keys.append(el('span', 'key', this.keyLabel('TASNextCar')), 'next car');
      h.appendChild(keys);
      const more = el('div', 'row dim small');
      more.append(el('span', 'key', this.keyLabel('TASStepBack')), el('span', 'key', this.keyLabel('TASStepForward')), '10 ms   ');
      if (n > 1) more.append(el('span', 'key', this.keyLabel('TASOffsetBack')), el('span', 'key', this.keyLabel('TASOffsetForward')), 'ghost offset   ',
        el('span', 'key', this.keyLabel('TASOffsetAlign')), 'align');
      h.appendChild(more);
      h.appendChild(el('div', 'row dim small', n > 1 ? 'With Shift ×10, with Ctrl (offset) ×100' : 'With Shift ×10'));
      // the ghost offset: one number when every other car is the same distance away, else one per car
      const signed = (ms) => (ms > 0 ? '+' : '') + fmt(ms);
      const distinct = [...new Set(offs.map((o) => o.ms))];
      if (distinct.length === 1 && distinct[0] !== 0) {
        const o = el('div', 'row');
        o.append('Ghost offset ', el('span', 'mod', signed(distinct[0])), el('span', 'dim', distinct[0] < 0 ? '  this car behind' : '  this car ahead'));
        h.appendChild(o);
      } else if (distinct.length > 1) {
        h.appendChild(el('div', 'row', 'Ghost offset'));
        for (const o of offs.slice(0, 6)) {
          const r = el('div', 'row small');
          r.append(el('span', 'dim', 'vs ' + o.name + '  '), el('span', o.ms ? 'mod' : 'dim', o.ms ? signed(o.ms) : '0'));
          h.appendChild(r);
        }
      }
      if (this.speed !== 1 || this.loopA != null) {
        const pl = el('div', 'row');
        if (this.speed !== 1) pl.append(el('span', 'mod', this.speed + '×'), '  ');
        if (this.loopA != null) pl.append('loop ' + fmt(this.loopA * 1000) + ' – ' + (this.loopB != null ? fmt(this.loopB * 1000) : '…') + (this.loopB != null && !this.loopOn ? ' (off)' : ''));
        h.appendChild(pl);
      }
    },

    /** The buttons beside the play button, and the loop on the time bar, as they are now. */
    paintBar() {
      const u = this.rt;
      if (u) {
        const t = this.speed + '×';
        if (u.speed.textContent !== t) u.speed.textContent = t;
        u.speed.classList.toggle('slow', this.speed !== 1);
        const label = this.loopA != null && this.loopB == null ? 'A–' : 'A–B';
        if (u.loop.textContent !== label) u.loop.textContent = label;
        u.loop.classList.toggle('on', this.loopA != null);
      }
      this.paintRange();
    },

    paintRange() {
      const r = this.range;
      if (!r || !this.api) return;
      // the game's time bar spans the watched car's length (its own marks are placed the same way)
      const total = this.api.cars()[this.api.focus()].settings.time.numberOfFrames / 1000;
      if (this.loopA == null || !total) { r.classList.add('hide'); return; }
      const left = Math.max(0, Math.min(1, this.loopA / total));
      const right = this.loopB == null ? left : Math.max(left, Math.min(1, this.loopB / total));
      r.classList.remove('hide');
      r.classList.toggle('open', this.loopB == null);
      r.classList.toggle('off', this.loopB != null && !this.loopOn);
      r.style.left = (left * 100).toFixed(3) + '%';
      r.style.width = ((right - left) * 100).toFixed(3) + '%';
    },

    // ---------------------------------------------------------------- playback speed and the loop
    rate(viewer) { return viewer === this.viewer ? this.speed : 1; },
    wrap(viewer, t) {
      if (viewer !== this.viewer || !this.loopOn || this.loopA == null || this.loopB == null || this.loopB <= this.loopA) return t;
      return t >= this.loopB ? this.loopA : t;
    },
    setSpeed(v) { if (v === this.speed) return; this.speed = v; this.toast('Speed ' + v + '×', 900); },
    /** The next speed up or down; the button goes round, the keys stop at the ends. */
    stepSpeed(dir, round) {
      let i = SPEEDS.indexOf(this.speed);
      if (i < 0) i = SPEEDS.indexOf(1);
      i += dir;
      i = round ? (i + SPEEDS.length) % SPEEDS.length : Math.max(0, Math.min(SPEEDS.length - 1, i));
      this.setSpeed(SPEEDS[i]);
    },

    // the loop (as in Tweaks): from here, to here (it starts looping), on/off; the button goes start → end → off
    markStart() {
      const now = this.api.time();
      this.loopA = now;
      if (this.loopB != null && this.loopB <= now) this.loopB = null;
      this.loopOn = this.loopB != null;
      this.toast('Loop from ' + fmt(now * 1000) + (this.loopB != null ? ' to ' + fmt(this.loopB * 1000) : ''), 1200);
    },
    markEnd() {
      const now = this.api.time();
      if (this.loopA == null || this.loopA >= now) this.loopA = 0;        // no start before here: from the beginning
      if (now <= this.loopA) { this.toast('The loop has to end after it starts', 1400); return; }
      this.loopB = now; this.loopOn = true;
      this.api.seek(this.loopA);
      this.toast('Looping ' + fmt(this.loopA * 1000) + ' – ' + fmt(now * 1000), 1400);
    },
    toggleLoop() {
      if (this.loopA == null || this.loopB == null) {
        // nothing set: the whole replay
        this.loopA = this.loopA == null ? 0 : this.loopA;
        this.loopB = this.api.duration();
        if (this.loopB <= this.loopA) { this.loopA = this.loopB = null; return; }
        this.loopOn = false;
      }
      this.loopOn = !this.loopOn;
      this.toast(this.loopOn ? 'Looping ' + fmt(this.loopA * 1000) + ' – ' + fmt(this.loopB * 1000) : 'Loop off', 1200);
    },
    cycleLoop() {
      if (this.loopA == null) this.markStart();
      else if (this.loopB == null) this.markEnd();
      else { this.loopA = this.loopB = null; this.loopOn = false; this.toast('Loop off', 900); }
    },

    /** Steps of ms, paused (the game's own step keys move 1 ms). */
    step(ms) {
      if (!this.api) return;
      this.api.setPaused(true);
      const t = Math.round(this.api.time() * 1000) + ms;
      this.api.seek(Math.max(0, t) / 1000);
    },

    // ---------------------------------------------------------------- keys (the viewer asks first)
    viewerKey(viewer, e) {
      if (viewer !== this.viewer || !this.api) return false;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return false;
      const act = (fn, allowRepeat) => { if (e.repeat && !allowRepeat) { e.preventDefault(); return true; } fn(); e.preventDefault(); return true; };
      if (this.keyIs(e, 'TASEditor')) return act(() => this.openEditorWindow());
      if (this.keyIs(e, 'TASBrute')) return act(() => { if (window.TASBrute) window.TASBrute.openWindow(); });
      if (this.keyIs(e, 'TASNextCar')) return act(() => { const n = this.api.cars().length; if (n > 1) this.api.setFocus((this.api.focus() + 1) % n); });
      // steps: 10 ms, with Shift 100 ms (held, they repeat)
      if (this.keyIs(e, 'TASStepBack')) return act(() => this.step(e.shiftKey ? -100 : -10), true);
      if (this.keyIs(e, 'TASStepForward')) return act(() => this.step(e.shiftKey ? 100 : 10), true);
      // the ghost offset: the watched car 1 ms back or ahead of the others (Shift 10, Ctrl 100; held, they repeat)
      if (this.keyIs(e, 'TASOffsetBack') || this.keyIs(e, 'TASOffsetForward')) return act(() => {
        const ms = e.ctrlKey ? 100 : e.shiftKey ? 10 : 1;
        this.setOffset(this.offset() + (this.keyIs(e, 'TASOffsetBack') ? -ms : ms));
      }, true);
      if (this.keyIs(e, 'TASOffsetReset')) return act(() => { this.clearOffsets(); this.toast('No ghost offset', 900); });
      if (this.keyIs(e, 'TASOffsetAlign')) return act(() => this.alignAtCheckpoint());
      if (this.keyIs(e, 'TASLines')) return act(() => {
        this.prefs.lines = this.prefs.lines === false;
        this.savePrefs();
        this.toast(this.prefs.lines ? 'Racing lines on' : 'Racing lines off', 900);
      });
      if (this.keyIs(e, 'TASSlower')) return act(() => this.stepSpeed(-1));
      if (this.keyIs(e, 'TASFaster')) return act(() => this.stepSpeed(1));
      if (this.keyIs(e, 'TASNormalSpeed')) return act(() => this.setSpeed(1));
      if (this.keyIs(e, 'TASLoopStart')) return act(() => this.markStart());
      if (this.keyIs(e, 'TASLoopEnd')) return act(() => this.markEnd());
      if (this.keyIs(e, 'TASLoop')) return act(() => this.toggleLoop());
      if (this.keyIs(e, 'TASTelemetry')) return act(() => {
        this.prefs.telemetry = this.prefs.telemetry === false;
        this.savePrefs();
        this.toast(this.prefs.telemetry ? 'Telemetry on' : 'Telemetry off', 900);
      });
      return false;
    },

    // ---------------------------------------------------------------- the input editor window
    openEditorWindow() {
      if (!window.tasBridge) { this.toast('The input editor needs the desktop build'); return; }
      window.tasBridge.openEditor();
      // the window says hello when it is ready; if it is already open it gets the current car now
      if (this.editorOpen) { this.sendState(); this.sendLoad(); }
    },

    reply(msg) { if (window.tasBridge) window.tasBridge.send(msg); },

    sendState(force) {
      if (!window.tasBridge || !this.session || (!this.editorOpen && !force)) return;
      const cars = this.session.cars.map((s, k) => {
        const pr = this.progress(k);
        return { index: k, name: s.name, kind: s.kind, modified: this.modified(k), hasDraft: s.draft != null, done: pr.done, finish: pr.done ? this.finishOf(k) : null, ref: this.finishRef(k) };
      });
      this.reply({ type: 'state', track: { id: this.session.trackId, name: this.session.trackName }, focus: this.api.focus(), cars });
    },

    sendLoad() {
      if (!window.tasBridge || !this.session || !this.editorOpen) return;
      const k = this.api.focus(), s = this.session.cars[k];
      const applied = this.appliedText(k);
      this.reply({ type: 'load', index: k, name: s.name, kind: s.kind, applied, text: s.draft != null ? s.draft : applied, original: s.kind === 'run' ? s.original : null });
    },

    fromEditor(msg) {
      switch (msg.type) {
        case 'hello':
          this.editorOpen = true;
          if (this.session) { this.sendState(); this.sendLoad(); } else this.reply({ type: 'detached' });
          this.hudKey = '';
          break;
        case 'closed':
          this.editorOpen = false; this.hudKey = '';
          break;
        case 'apply':
          this.apply(msg.index, String(msg.text || ''));
          break;
        case 'draft': {
          if (!this.session) break;
          const s = this.session.cars[msg.index];
          if (!s) break;
          const applied = this.appliedText(msg.index);
          s.draft = msg.text === applied ? null : String(msg.text);
          if (s.kind === 'tas') store.set(DRAFT + this.session.trackId, s.draft);
          this.hudKey = '';
          break;
        }
        case 'revert':
          this.revert(msg.index);
          break;
        case 'focus':
          if (this.api) this.api.setFocus(msg.index);
          break;
        case 'seek':
          if (this.api) { this.api.setPaused(true); this.api.seek(Math.max(0, msg.t) / 1000); }
          break;
        case 'pause':
          if (this.api) this.api.setPaused(!!msg.paused);
          break;
        case 'prefs':
          Object.assign(this.prefs, msg.prefs || {}); this.savePrefs();
          break;
      }
    },
  };

  window.TAS = TAS;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => TAS.init());
  else TAS.init();
})();
