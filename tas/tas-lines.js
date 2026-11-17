/*
 * PolyTrack TAS — racing lines.
 *
 * Each car's path drawn on the track as a dotted line: one dot at the car's position for each millisecond
 * of its run, in a colour of its own (the TAS car yellow), the car you watch a little brighter. The dots
 * are the positions the physics gave, so their spacing shows the speed: at 200 km/h, dots 1 ms apart are
 * 5.6 cm apart. Settings → TAS sets the milliseconds between dots and their size; the "Racing lines on/off"
 * key (B) shows and hides them.
 *
 * The dots follow the runs: frames simulated since are added every frame, and when a car's lane resumes
 * from a save point (tas-lane.js), its dots after that point go and come back with the new run (cut()).
 * The three.js classes come from the game's own copy (the viewer API's three()).
 */
(function () {
  'use strict';

  const COLORS = [0xffd54a, 0x4fc3f7, 0xf06292, 0x81c784, 0xffb74d, 0xba68c8, 0xe57373, 0x4db6ac];
  // dots are a fixed size on screen (pixels per step of the size setting): near the camera they stay
  // apart, so their spacing — the speed — shows; far off they run together into a thin line
  const SIZE = 1.5;

  /** One car's dots: a point cloud whose buffer grows with the run. */
  class Line {
    constructor(T, scene, entry, color) {
      this.T = T; this.scene = scene; this.entry = entry;
      this.cap = 0; this.count = 0; this.upTo = -1; this.step = 1;
      this.geo = new T.BufferGeometry();
      this.mat = new T.PointsMaterial({ color, size: 3 * SIZE, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false });
      this.points = new T.Points(this.geo, this.mat);
      this.points.frustumCulled = false;        // the cloud grows; its bounds are never computed
      this.points.renderOrder = 2;
      this.grow(8192);
      scene.add(this.points);
    }

    grow(cap) {
      const arr = new Float32Array(cap * 3);
      if (this.arr) arr.set(this.arr.subarray(0, this.count * 3));
      this.arr = arr;
      this.cap = cap;
      this.attr = new this.T.BufferAttribute(arr, 3);
      this.geo.setAttribute('position', this.attr);
      this.geo.setDrawRange(0, this.count);
    }

    /** The car's frames after `frame` are being simulated again: their dots go (frame -1: all of them). */
    cut(frame) {
      if (this.upTo <= frame) return;
      this.upTo = frame;
      this.count = frame < 0 ? 0 : Math.floor(frame / this.step) + 1;
      this.geo.setDrawRange(0, this.count);
    }

    /** Dots for the frames simulated since last time (every `step` ms); all again if the spacing changed. */
    sync(step) {
      if (step !== this.step) { this.step = step; this.cut(-1); }
      const replay = this.entry.replay, last = replay.getLastFrame().numberOfFrames;
      if (last <= this.upTo) return;
      const need = Math.floor(last / step) + 1;
      if (need > this.cap) this.grow(Math.max(need, this.cap * 2));
      const first = this.count, a = this.arr;
      for (let f = this.count * step; f <= last; f += step) {
        const s = replay.getFrame(f);
        if (!s) break;
        const i = this.count * 3;
        a[i] = s.position.x; a[i + 1] = s.position.y; a[i + 2] = s.position.z;
        this.count++;
      }
      this.upTo = last;
      // upload only what was added
      if (this.attr.addUpdateRange) { this.attr.clearUpdateRanges(); this.attr.addUpdateRange(first * 3, (this.count - first) * 3); }
      else if (this.attr.updateRange) { this.attr.updateRange.offset = first * 3; this.attr.updateRange.count = (this.count - first) * 3; }
      this.attr.needsUpdate = true;
      this.geo.setDrawRange(0, this.count);
    }

    dispose() {
      this.scene.remove(this.points);
      this.geo.dispose();
      this.mat.dispose();
    }
  }

  const TASLines = {
    api: null, T: null, scene: null, lines: new Map(),
    on: () => true, step: () => 1, size: () => 3,          // set by the TAS mod from its preferences and settings

    attach(api) {
      this.detach();
      try {
        const T = api.three(), scene = api.scene();
        if (!T || !T.Points || !new T.Points().isPoints || !scene || !scene.add) throw new Error('the game\'s three.js or scene is not where it was');
        this.api = api; this.T = T; this.scene = scene;
      } catch (e) { console.error('[tas] racing lines unavailable:', e); }
    },

    detach() {
      for (const l of this.lines.values()) l.dispose();
      this.lines.clear();
      this.api = null;
    },

    cut(entry, frame) { const l = this.lines.get(entry); if (l) l.cut(frame); },

    /** Every frame: show or hide, add new dots, size and brightness. */
    tick() {
      if (!this.api) return;
      const on = this.on();
      const step = Math.max(1, Math.min(100, Math.round(this.step()) || 1));
      const size = Math.max(1, Math.min(10, Math.round(this.size()) || 3)) * SIZE;
      const cars = this.api.cars(), focus = this.api.focus();
      for (let k = 0; k < cars.length; k++) {
        const e = cars[k];
        let l = this.lines.get(e);
        if (!l) {
          if (!on) continue;
          l = new Line(this.T, this.scene, e, COLORS[k % COLORS.length]);
          this.lines.set(e, l);
        }
        l.points.visible = on;
        if (!on) continue;
        l.sync(step);
        l.mat.size = size;
        l.mat.opacity = k === focus ? 0.95 : 0.6;
      }
    },
  };

  window.TASLines = TASLines;
})();
