/*
 * PolyTrack TAS — lanes: where the cars you edit are simulated.
 *
 * A lane is one car in a physics worker of its own: the game's own worker code, plus the lane messages
 * in tools/patches.mjs (LANE_WORKER). With the car alone in it, a copy of the worker's memory is a copy
 * of that car's whole physics state, so the lane keeps save points as the run goes. Applying new inputs
 * then resumes from the last save point at or before the first frame they change instead of from the
 * start. Everything before that frame is the same run, so the result is exactly what a full simulation
 * gives, frame for frame — the self-test checks it against the game's own simulation — only sooner.
 *
 * The lane feeds the replay viewer's car the way the viewer's own simulation does (its frames,
 * checkpoint times and finish speed). Resuming cuts the car's frames back to the save point first.
 */
(function () {
  'use strict';

  const I = window.TASInputs;
  const EVERY = 4000;           // frames between the sparse save points (denser just after where a run resumes)
  const BUDGET = 128 << 20;     // save point memory per lane

  class Lane {
    /** A lane for car k of the viewer (api = the viewer's __tasApi()); hooks: done(lane, stats), error(lane, message). */
    constructor(api, k, hooks) {
      const G = window.__tasGame;
      this.api = api;
      this.k = k;
      this.hooks = hooks || {};
      this.sim = new G.SimulationWorker(false, G.trackParts, G.loader);
      this.worker = this.sim.__tasWorker();
      this.onMessage = (ev) => { const d = ev.data; if (d && d.__tas) this.message(d); };
      this.worker.addEventListener('message', this.onMessage);
      this.carId = null;          // the car's id in this lane's worker
      this.changes = null;        // the inputs it is driving (change list) and how far
      this.target = 0;
      this.prev = null;           // the last frame pushed (for checkpoints, as the viewer does)
      this.seq = 0;
      this.pending = null;        // the run in progress: { id, t0, from, firstFrameAt }
      this.waits = new Map();
      this.stats = null;
      this.disposed = false;
      this.usedAt = performance.now();
    }

    car() { return this.api.cars()[this.k]; }
    post(msg) { this.worker.postMessage(msg); }
    busy() { return this.pending != null; }

    /**
     * Drive the car with this recording (rec), the same inputs as channels and as a change list, up to
     * frame `target`. The first time, from the start; after that, from the last save point at or before
     * the first frame that differs from what the lane drove before.
     */
    run(rec, channels, changes, target) {
      if (this.disposed) return -1;
      const q = this.car();
      const id = ++this.seq;
      this.usedAt = performance.now();
      q.__tasBusy = true;
      this.pending = { id, t0: performance.now(), from: null, firstFrameAt: null };
      if (this.carId == null) {
        // the viewer's own simulation of this car stops; the lane takes it from the start
        if (q.carId != null) { this.api.sim().deleteCar(q.carId); q.carId = null; }
        const d = this.api.spawn(this.sim, rec, (st) => this.push(st));
        this.carId = d.id;
        q.replay.__tasTruncate(0);
        if (window.TASTelemetry) window.TASTelemetry.cut(q, -1);
        if (window.TASLines) window.TASLines.cut(q, -1);
        q.replay.push(d.carState);
        q.checkpointTimes = [];
        q.finishSpeed = null;
        this.syncCheckpoints(q);
        this.prev = d.carState;
        this.refreshCar(q, 0);
        this.pending.from = 0;
        this.post({ __tas: 'lane', id, carId: this.carId, channels, target, every: EVERY, budget: BUDGET });
      } else {
        const frame = Math.min(I.firstDifference(this.changes, changes), this.target, target);
        this.post({ __tas: 'restore', id, carId: this.carId, frame, channels, target });
      }
      this.changes = changes;
      this.target = target;
      return id;
    }

    /** A frame from the lane's worker, as the viewer's own callback takes it. */
    push(st) {
      if (this.disposed) return;
      const q = this.car();
      if (this.pending && this.pending.firstFrameAt == null) this.pending.firstFrameAt = performance.now();
      q.replay.push(st);
      if (st.nextCheckpointIndex > this.prev.nextCheckpointIndex) { q.checkpointTimes.push(new window.__tasTime(st.frames)); this.syncCheckpoints(q); }
      if (st.finishFrames != null && q.finishSpeed == null) q.finishSpeed = st.speedKmh;
      this.prev = st;
    }

    syncCheckpoints(q) { if (this.k === this.api.focus()) this.api.timebar().checkpointTimes = q.checkpointTimes; }

    /** If the car is showing a frame past `frame`, put it back there (that frame is still right); the viewer moves it on as new frames come. */
    refreshCar(q, frame) {
      try {
        const st = q.replay.getFrame(frame);
        if (st && q.car.getTime().numberOfFrames > frame) q.car.setCarState(st, true);
      } catch (e) { console.error('[tas] lane: could not reset the car', e); }
    }

    message(d) {
      if (this.disposed) return;
      const q = this.car();
      switch (d.__tas) {
        case 'restored': {
          // every frame up to d.frame is still right; the ones after it are simulated again
          const S = d.frame;
          q.replay.__tasTruncate(S + 1);
          if (window.TASTelemetry) window.TASTelemetry.cut(q, S);
          if (window.TASLines) window.TASLines.cut(q, S);
          const st = q.replay.getFrame(S);
          q.checkpointTimes = q.checkpointTimes.filter((c) => c.numberOfFrames <= S);
          this.syncCheckpoints(q);
          if (st.finishFrames == null) q.finishSpeed = null;
          this.prev = st;
          this.refreshCar(q, S);
          if (this.pending && this.pending.id === d.id) { this.pending.from = S; this.pending.restoreMs = d.ms; }
          break;
        }
        case 'done':
          if (this.pending && this.pending.id === d.id) {
            const p = this.pending;
            this.pending = null;
            q.__tasBusy = false;
            this.stats = Object.assign({}, d, { wall: performance.now() - p.t0, from: p.from, restoreMs: p.restoreMs || 0, firstFrameMs: p.firstFrameAt == null ? null : p.firstFrameAt - p.t0 });
            if (this.hooks.done) this.hooks.done(this, this.stats);
          }
          break;
        case 'info': {
          const w = this.waits.get(d.id);
          if (w) { this.waits.delete(d.id); w(d); }
          break;
        }
        case 'error':
          console.error('[tas] lane for car ' + this.k + ':', d.message);
          this.pending = null;
          q.__tasBusy = false;
          if (this.hooks.error) this.hooks.error(this, d.message);
          break;
      }
    }

    /** The worker's numbers: memory, save points and their size. */
    info() {
      return new Promise((resolve) => {
        const id = ++this.seq;
        this.waits.set(id, resolve);
        this.post({ __tas: 'info', id });
        setTimeout(() => { if (this.waits.delete(id)) resolve(null); }, 3000);
      });
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.worker.removeEventListener('message', this.onMessage);
      try { this.sim.dispose(); } catch { }
      for (const w of this.waits.values()) w(null);
      this.waits.clear();
      try { const q = this.car(); if (q) q.__tasBusy = false; } catch { }
    }
  }

  window.TASLane = Lane;
})();
