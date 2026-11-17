/*
 * PolyTrack TAS — the bruteforce's core: everything it decides, with nothing of the game or the browser
 * in it, so the same code runs in the bruteforce's physics workers (tools/patches.mjs puts it there), in
 * the game window and in Node (tools/test/brute.test.js).
 *
 *   - Hitboxes. The game counts a checkpoint when the car's own detection box (a box in the car's frame,
 *     centre (0, 0.48, -0.15), half-size 0.89 x 0.22 x 1.8) overlaps the checkpoint's box, tested after
 *     every physics step with three.js's box-box test. PolyTrack 0.5.1 did this in JavaScript; 0.6.3 does
 *     the same in its physics, and this reproduces every checkpoint and finish frame of 40 leaderboard runs
 *     on 5 tracks exactly (the `probe` self-test). Trigger boxes use the same test, so a trigger box is a
 *     checkpoint's hitbox you can move, turn and size.
 *   - Sub-millisecond hit times: between the frame before a hit and the frame of it, the car is moved in a
 *     straight line (and turned evenly), and the moment its box first touches is found by halving.
 *   - The changes a try makes inside the window (toggle, insert, shift), each only on the keys and at the
 *     times the settings allow; and, for the exhaustive search, every on/off pattern of those.
 *   - The score of a run, and which of two is better.
 *
 * Times are milliseconds (one physics tick). A run's inputs inside the window [S, E] are one byte per tick
 * (the keys held: w 1, a 2, s 4, d 8, r 16, as in tas-inputs.js); outside it they are the run's own.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TASBruteCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = ['w', 'a', 's', 'd', 'r'];
  const BIT = { w: 1, a: 2, s: 4, d: 8, r: 16 };
  const TYPES = ['toggle', 'insert', 'shift'];

  // ================================================================== geometry
  // the car's detection box, in the car's own frame (PolyTrack's detectorBoxCenter / detectorBoxSize)
  const CAR_CENTER = [0, 0.48, -0.15];
  const CAR_HALF = [0.89, 0.22, 1.8];
  const CAR_RADIUS = Math.hypot(CAR_HALF[0], CAR_HALF[1], CAR_HALF[2]);
  const PART_SIZE = 5;
  // a track part's rotation: [rotationAxis][rotation] → quaternion (x, y, z, w), the game's own table
  const PART_ROTATIONS = [
    [[0, 0, 0, 1], [0, .7071067811865475, 0, .7071067811865476], [0, 1, 0, 0], [0, .7071067811865476, 0, -.7071067811865475]],
    [[0, 0, 1, 0], [.7071067811865475, 0, .7071067811865476, 0], [1, 0, 0, 0], [.7071067811865476, 0, -.7071067811865475, 0]],
    [[0, 0, -.7071067811865477, .7071067811865475], [.5, .5, -.5, .5], [.7071067811865475, .7071067811865477, 0, 0], [.5, .5, .5, -.5]],
    [[0, 0, .7071067811865475, .7071067811865476], [.5, -.5, .5, .5], [.7071067811865476, -.7071067811865475, 0, 0], [.5, -.5, -.5, -.5]],
    [[.7071067811865475, 0, 0, .7071067811865476], [.5, .5, .5, .5], [0, .7071067811865476, .7071067811865475, 0], [-.5, .5, .5, -.5]],
    [[-.7071067811865477, 0, 0, .7071067811865475], [-.5, -.5, .5, .5], [0, -.7071067811865475, .7071067811865477, 0], [.5, -.5, .5, -.5]],
  ];

  /** v turned by quaternion q (three.js applyQuaternion). */
  function rotate(q, v) {
    const x = q[0], y = q[1], z = q[2], w = q[3], vx = v[0], vy = v[1], vz = v[2];
    const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  }

  /** A box: centre c, unit axes u[0..2], half-sizes e, and r, the radius of a sphere around it (for a quick "too far to touch"). */
  function newBox() { return { c: [0, 0, 0], u: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], e: [0, 0, 0], r: Infinity }; }
  /** A box that came as plain data (a message): its sphere's radius worked out again. */
  function fixBox(b) { b.r = Math.hypot(b.e[0], b.e[1], b.e[2]); return b; }

  /**
   * The car's detection box at a pose (position p, quaternion q), into `out`: its centre turned with the
   * car and moved to it, its axes the columns of the car's rotation matrix, as PolyTrack builds it.
   */
  function carBox(px, py, pz, x, y, z, w, out) {
    const B = out || newBox();
    const cx = CAR_CENTER[0], cy = CAR_CENTER[1], cz = CAR_CENTER[2];
    const ix = w * cx + y * cz - z * cy, iy = w * cy + z * cx - x * cz, iz = w * cz + x * cy - y * cx, iw = -x * cx - y * cy - z * cz;
    B.c[0] = ix * w + iw * -x + iy * -z - iz * -y + px;
    B.c[1] = iy * w + iw * -y + iz * -x - ix * -z + py;
    B.c[2] = iz * w + iw * -z + ix * -y - iy * -x + pz;
    const u0 = B.u[0], u1 = B.u[1], u2 = B.u[2];
    u0[0] = 1 - 2 * (y * y + z * z); u0[1] = 2 * (x * y + z * w); u0[2] = 2 * (x * z - y * w);
    u1[0] = 2 * (x * y - z * w); u1[1] = 1 - 2 * (x * x + z * z); u1[2] = 2 * (y * z + x * w);
    u2[0] = 2 * (x * z + y * w); u2[1] = 2 * (y * z - x * w); u2[2] = 1 - 2 * (x * x + y * y);
    B.e[0] = CAR_HALF[0]; B.e[1] = CAR_HALF[1]; B.e[2] = CAR_HALF[2];
    B.r = CAR_RADIUS;
    return B;
  }

  /**
   * A track part's detector, as the game places it: the detector's centre and size turned with the part,
   * the centre moved to the part's place; a box along the world's axes (Box3 from centre and size, then
   * an OBB from that, as PolyTrack does).
   */
  function partBox(part) {
    const q = PART_ROTATIONS[part.rotationAxis][part.rotation];
    const c = rotate(q, part.detector.center);
    c[0] += part.x * PART_SIZE; c[1] += part.y * PART_SIZE; c[2] += part.z * PART_SIZE;
    const s = rotate(q, part.detector.size).map(Math.abs);
    const B = newBox();
    for (let i = 0; i < 3; i++) {
      const lo = c[i] - s[i] * 0.5, hi = c[i] + s[i] * 0.5;
      B.c[i] = (lo + hi) * 0.5;
      B.e[i] = (hi - lo) * 0.5;
    }
    B.r = Math.hypot(B.e[0], B.e[1], B.e[2]);
    return B;
  }

  const RAD = Math.PI / 180;
  /** A trigger box: centre, rotation (yaw, pitch, roll in degrees: turned about Y, then X, then Z) and size. */
  function triggerBox(t) {
    const cy = Math.cos(t.rot[0] * RAD), sy = Math.sin(t.rot[0] * RAD);
    const cp = Math.cos(t.rot[1] * RAD), sp = Math.sin(t.rot[1] * RAD);
    const cr = Math.cos(t.rot[2] * RAD), sr = Math.sin(t.rot[2] * RAD);
    // R = Ry * Rx * Rz; its columns are the box's axes
    const R = [
      [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
      [cp * sr, cp * cr, -sp],
      [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
    ];
    const B = newBox();
    B.c = [t.c[0], t.c[1], t.c[2]];
    B.u = [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
    B.e = [Math.abs(t.size[0]) / 2, Math.abs(t.size[1]) / 2, Math.abs(t.size[2]) / 2];
    B.r = Math.hypot(B.e[0], B.e[1], B.e[2]);
    return B;
  }

  /** The 8 corners of a box. */
  function corners(B) {
    const out = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
      out.push([0, 1, 2].map((i) => B.c[i] + a * B.e[0] * B.u[0][i] + b * B.e[1] * B.u[1][i] + c * B.e[2] * B.u[2][i]));
    }
    return out;
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const R_ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], AR_ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v_ = [0, 0, 0], t_ = [0, 0, 0];

  /** Whether two boxes overlap: three.js's OBB.intersectsOBB (Ericson's separating axes), epsilon = Number.EPSILON. */
  function overlaps(A, B) {
    const eps = Number.EPSILON, R = R_, AR = AR_;
    const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
    // far apart: no need for the axes (spheres around both boxes do not touch)
    const rr = A.r + B.r;
    if (dx * dx + dy * dy + dz * dz > rr * rr * 1.0000001 + 1e-9) return false;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { R[i][j] = dot(A.u[i], B.u[j]); AR[i][j] = Math.abs(R[i][j]) + eps; }
    v_[0] = dx; v_[1] = dy; v_[2] = dz;
    const t = t_; t[0] = dot(v_, A.u[0]); t[1] = dot(v_, A.u[1]); t[2] = dot(v_, A.u[2]);
    const a = A.e, b = B.e;
    let ra, rb;
    for (let i = 0; i < 3; i++) { ra = a[i]; rb = b[0] * AR[i][0] + b[1] * AR[i][1] + b[2] * AR[i][2]; if (Math.abs(t[i]) > ra + rb) return false; }
    for (let i = 0; i < 3; i++) { ra = a[0] * AR[0][i] + a[1] * AR[1][i] + a[2] * AR[2][i]; rb = b[i]; if (Math.abs(t[0] * R[0][i] + t[1] * R[1][i] + t[2] * R[2][i]) > ra + rb) return false; }
    ra = a[1] * AR[2][0] + a[2] * AR[1][0]; rb = b[1] * AR[0][2] + b[2] * AR[0][1]; if (Math.abs(t[2] * R[1][0] - t[1] * R[2][0]) > ra + rb) return false;
    ra = a[1] * AR[2][1] + a[2] * AR[1][1]; rb = b[0] * AR[0][2] + b[2] * AR[0][0]; if (Math.abs(t[2] * R[1][1] - t[1] * R[2][1]) > ra + rb) return false;
    ra = a[1] * AR[2][2] + a[2] * AR[1][2]; rb = b[0] * AR[0][1] + b[1] * AR[0][0]; if (Math.abs(t[2] * R[1][2] - t[1] * R[2][2]) > ra + rb) return false;
    ra = a[0] * AR[2][0] + a[2] * AR[0][0]; rb = b[1] * AR[1][2] + b[2] * AR[1][1]; if (Math.abs(t[0] * R[2][0] - t[2] * R[0][0]) > ra + rb) return false;
    ra = a[0] * AR[2][1] + a[2] * AR[0][1]; rb = b[0] * AR[1][2] + b[2] * AR[1][0]; if (Math.abs(t[0] * R[2][1] - t[2] * R[0][1]) > ra + rb) return false;
    ra = a[0] * AR[2][2] + a[2] * AR[0][2]; rb = b[0] * AR[1][1] + b[1] * AR[1][0]; if (Math.abs(t[0] * R[2][2] - t[2] * R[0][2]) > ra + rb) return false;
    ra = a[0] * AR[1][0] + a[1] * AR[0][0]; rb = b[1] * AR[2][2] + b[2] * AR[2][1]; if (Math.abs(t[1] * R[0][0] - t[0] * R[1][0]) > ra + rb) return false;
    ra = a[0] * AR[1][1] + a[1] * AR[0][1]; rb = b[0] * AR[2][2] + b[2] * AR[2][0]; if (Math.abs(t[1] * R[0][1] - t[0] * R[1][1]) > ra + rb) return false;
    ra = a[0] * AR[1][2] + a[1] * AR[0][2]; rb = b[0] * AR[2][1] + b[1] * AR[2][0]; if (Math.abs(t[1] * R[0][2] - t[0] * R[1][2]) > ra + rb) return false;
    return true;
  }

  /** Squared distance from point p to the solid box B. */
  function pointBoxDist2(p, B) {
    const d = [p[0] - B.c[0], p[1] - B.c[1], p[2] - B.c[2]];
    let s = 0;
    for (let i = 0; i < 3; i++) { const x = Math.abs(dot(d, B.u[i])) - B.e[i]; if (x > 0) s += x * x; }
    return s;
  }

  /** Squared distance between segments p1-q1 and p2-q2 (Ericson, ClosestPtSegmentSegment). */
  function segSegDist2(p1, q1, p2, q2) {
    const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]], r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
    const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    let s, t;
    if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
    else if (a <= 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
    else {
      const c = dot(d1, r);
      if (e <= 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else {
        const b = dot(d1, d2), den = a * e - b * b;
        s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
        else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
      }
    }
    const x = r[0] + d1[0] * s - d2[0] * t, y = r[1] + d1[1] * s - d2[1] * t, z = r[2] + d1[2] * s - d2[2] * t;
    return x * x + y * y + z * z;
  }

  // a box's 12 edges, as pairs of corner indices (corners() order: bits a b c)
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  /**
   * The gap between two boxes, in metres (0 when they overlap): the closest two points of two separate
   * boxes are a corner of one and a point of the other, or a point on an edge of each.
   */
  function boxDistance(A, B) {
    if (overlaps(A, B)) return 0;
    const ca = corners(A), cb = corners(B);
    let best = Infinity;
    for (const p of ca) best = Math.min(best, pointBoxDist2(p, B));
    for (const p of cb) best = Math.min(best, pointBoxDist2(p, A));
    for (const [i, j] of EDGES) for (const [k, l] of EDGES) best = Math.min(best, segSegDist2(ca[i], ca[j], cb[k], cb[l]));
    return Math.sqrt(best);
  }

  // ---------------------------------------------------------------- poses between frames
  // a pose: Float64Array [px, py, pz, qx, qy, qz, qw, speed (km/h; never negative unless the speed is 'signed')]
  const POSE = 8;
  const lerpBox_ = newBox();
  /** The car's box a fraction f of the way from pose a to pose b (moved in a straight line, turned evenly). */
  function boxBetween(a, b, f) {
    let bx = b[3], by = b[4], bz = b[5], bw = b[6];
    if (a[3] * bx + a[4] * by + a[5] * bz + a[6] * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let x = a[3] + (bx - a[3]) * f, y = a[4] + (by - a[4]) * f, z = a[5] + (bz - a[5]) * f, w = a[6] + (bw - a[6]) * f;
    const n = Math.hypot(x, y, z, w) || 1;
    x /= n; y /= n; z /= n; w /= n;
    return carBox(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, x, y, z, w, lerpBox_);
  }
  const anyOverlap = (car, boxes) => { for (let i = 0; i < boxes.length; i++) if (overlaps(car, boxes[i])) return true; return false; };
  /**
   * When, between the frame before (pose a) and this one (pose b), the car's box first touched one of
   * `boxes`: a fraction of the millisecond, found by halving (0 if it already touched at a; 1 if it does
   * not touch at b either).
   */
  function touchFraction(a, b, boxes) {
    if (anyOverlap(boxBetween(a, b, 0), boxes)) return 0;
    if (!anyOverlap(boxBetween(a, b, 1), boxes)) return 1;
    let lo = 0, hi = 1;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) * 0.5;
      if (anyOverlap(boxBetween(a, b, mid), boxes)) hi = mid; else lo = mid;
    }
    return hi;
  }

  // ================================================================== the score of a run
  /**
   * Objectives, in order: groups (a group is hit when any of its members is: alternatives, like
   * checkpoints that share an order), each member a trigger box, one of the game's checkpoint orders
   * (k, from 0) or the finish. No-gos are boxes to stay out of, all the time.
   *
   * cfg: { groups: [{ name, members: [{ kind: 'box', box } | { kind: 'cp', k, boxes } | { kind: 'fin', boxes }] }],
   *        nogos: [{ name, box }], S, C, alpha (0 distance … 1 speed), mode ('check' | 'hit'), vref (km/h),
   *        speed ('raw', the default | 'signed') }
   *
   * The rules:
   *   - a group counts when it is the next one: a trigger box when the car's box overlaps it; a checkpoint
   *     or the finish when the game itself registers it, at or after the frame the group before was hit
   *     (one the game registered earlier was passed out of order and can never count);
   *   - a no-go counts when the car's box goes into it after the start time: the try ends there;
   *   - the score compares, in order: no no-go touched; more groups hit; then
   *     (1 − alpha)·distance + alpha·speed, where distance is in metres — minus the gap to the next group,
   *     or, with every group hit, the time to spare at the check time as the metres it is worth at vref —
   *     and speed in km/h, at the check time (mode 'check') or where it reached the last group ('hit');
   *     then the earlier last hit.
   *
   * Speed is the car's raw speed: the length of its velocity, never negative. The game's number is the
   * same with a minus sign whenever the velocity points behind the car's nose (the physics: 3.6 × the
   * length of the chassis' linear velocity, negated when it points against the forward axis), so a car
   * thrown backwards, or flying or sliding tail first, would otherwise count as slow; the sign is dropped.
   * With speed 'signed' it is kept: the game's number as it is.
   */
  class Tracker {
    constructor(cfg) {
      this.cfg = cfg;
      this.raw = cfg.speed !== 'signed';
      this.n = cfg.groups.length;
      this.car = newBox();
      this.cur = new Float64Array(POSE);
      this.prev = new Float64Array(POSE);
      this.cpFrame = new Int32Array(64).fill(-1);   // game checkpoint order k → frame it was registered (-1: not)
      this.cpT = new Float64Array(64);
      this.cpV = new Float64Array(64);
      this.hitT = new Float64Array(Math.max(1, this.n));
      this.hitV = new Float64Array(Math.max(1, this.n));
      this.nogoIn = new Uint8Array(Math.max(1, cfg.nogos.length));
      this.reset();
    }

    reset() {
      this.g = 0; this.lastHitFrame = 0; this.prevNci = 0; this.prevFin = false;
      this.cpFrame.fill(-1); this.finFrame = -1; this.finT = 0; this.finV = 0;
      this.nogoIn.fill(0); this.touch = -1; this.touchT = 0; this.endFrame = -1; this.frameNo = 0;
      this.prev.fill(0); this.cur.fill(0); this.prev[6] = this.cur[6] = 1;
    }

    /** The state between frames, to come back to (the start of every try). */
    save() {
      return { g: this.g, lastHitFrame: this.lastHitFrame, prevNci: this.prevNci, prevFin: this.prevFin, cpFrame: this.cpFrame.slice(), cpT: this.cpT.slice(), cpV: this.cpV.slice(),
        finFrame: this.finFrame, finT: this.finT, finV: this.finV, hitT: this.hitT.slice(), hitV: this.hitV.slice(), nogoIn: this.nogoIn.slice(), prev: this.prev.slice(), frameNo: this.frameNo };
    }
    load(s) {
      this.g = s.g; this.lastHitFrame = s.lastHitFrame; this.prevNci = s.prevNci; this.prevFin = s.prevFin;
      this.cpFrame.set(s.cpFrame); this.cpT.set(s.cpT); this.cpV.set(s.cpV);
      this.finFrame = s.finFrame; this.finT = s.finT; this.finV = s.finV;
      this.hitT.set(s.hitT); this.hitV.set(s.hitV); this.nogoIn.set(s.nogoIn); this.prev.set(s.prev); this.cur.set(s.prev);
      this.touch = -1; this.touchT = 0; this.endFrame = -1; this.frameNo = s.frameNo;
    }

    /** The pose of frame 0 (the start), before any frame is given. */
    begin(px, py, pz, qx, qy, qz, qw, v) {
      const p = this.prev; p[0] = px; p[1] = py; p[2] = pz; p[3] = qx; p[4] = qy; p[5] = qz; p[6] = qw; p[7] = this.raw ? Math.abs(v) : v;
      this.cur.set(p);
      const car = carBox(px, py, pz, qx, qy, qz, qw, this.car);
      this.cfg.nogos.forEach((ng, j) => { this.nogoIn[j] = overlaps(car, ng.box) ? 1 : 0; });
    }

    /**
     * Frame f's state. `live` false: the run before the start time (no-gos do not end it). Returns true
     * when the try is over (a no-go, or every group hit in mode 'hit').
     */
    frame(f, px, py, pz, qx, qy, qz, qw, v, nci, fin, live) {
      const cfg = this.cfg, prev = this.prev, cur = this.cur;
      if (this.raw) v = Math.abs(v);                  // the raw speed, whichever way the car moves (above)
      cur[0] = px; cur[1] = py; cur[2] = pz; cur[3] = qx; cur[4] = qy; cur[5] = qz; cur[6] = qw; cur[7] = v;
      this.frameNo = f;
      const car = carBox(px, py, pz, qx, qy, qz, qw, this.car);
      let over = false;
      // what the game itself registered this frame
      if (nci > this.prevNci) {
        for (let k = this.prevNci; k < nci && k < 64; k++) {
          const m = this.cpMember(k), phi = m ? touchFraction(prev, cur, m.boxes) : 1;
          this.cpFrame[k] = f; this.cpT[k] = f - 1 + phi; this.cpV[k] = prev[7] + (v - prev[7]) * phi;
        }
        this.prevNci = nci;
      }
      if (fin && !this.prevFin) {
        const m = this.finMember(), phi = m ? touchFraction(prev, cur, m.boxes) : 1;
        this.finFrame = f; this.finT = f - 1 + phi; this.finV = prev[7] + (v - prev[7]) * phi;
        this.prevFin = true;
      }
      // no-gos: going into one ends the try (after the start time)
      for (let j = 0; j < cfg.nogos.length; j++) {
        const inside = overlaps(car, cfg.nogos[j].box);
        if (inside && !this.nogoIn[j] && live && this.touch < 0) {
          this.touch = j; this.touchT = f - 1 + touchFraction(prev, cur, [cfg.nogos[j].box]); over = true;
        }
        this.nogoIn[j] = inside ? 1 : 0;
      }
      // the next groups, as many as this frame reaches
      while (!over && this.g < this.n) {
        const grp = cfg.groups[this.g];
        let T = Infinity, V = 0;
        for (const m of grp.members) {
          if (m.kind === 'box') {
            if (overlaps(car, m.box)) { const phi = touchFraction(prev, cur, [m.box]), t = f - 1 + phi; if (t < T) { T = t; V = prev[7] + (v - prev[7]) * phi; } }
          } else if (m.kind === 'cp') {
            const at = this.cpFrame[m.k];
            if (at >= 0 && at >= this.lastHitFrame && this.cpT[m.k] < T) { T = this.cpT[m.k]; V = this.cpV[m.k]; }
          } else if (m.kind === 'fin') {
            if (this.finFrame >= 0 && this.finFrame >= this.lastHitFrame && this.finT < T) { T = this.finT; V = this.finV; }
          }
        }
        if (T === Infinity) break;
        this.hitT[this.g] = T; this.hitV[this.g] = V;
        this.lastHitFrame = Math.ceil(T - 1e-9);
        this.g++;
        if (this.g === this.n && cfg.mode === 'hit') over = true;
      }
      prev.set(cur);
      if (over) this.endFrame = f;
      return over;
    }

    cpMember(k) { for (const g of this.cfg.groups) for (const m of g.members) if (m.kind === 'cp' && m.k === k) return m; return this.cfg.cpBoxes && this.cfg.cpBoxes[k] ? { boxes: this.cfg.cpBoxes[k] } : null; }
    finMember() { for (const g of this.cfg.groups) for (const m of g.members) if (m.kind === 'fin') return m; return this.cfg.finBoxes ? { boxes: this.cfg.finBoxes } : null; }

    /** The gap from the car's box (at the current pose) to the nearest member of group g. */
    gapTo(g) {
      let best = Infinity;
      for (const m of this.cfg.groups[g].members) {
        const boxes = m.kind === 'box' ? [m.box] : m.boxes;
        for (const b of boxes) best = Math.min(best, boxDistance(this.car, b));
      }
      return best;
    }

    /** The score, at the frame the try ended (the last frame given). */
    result() {
      const cfg = this.cfg, n = this.n, g = this.g, cur = this.cur;
      const s = { clean: this.touch < 0, hits: g, n, D: 0, V: cur[7], T: Infinity, gap: null, at: this.frameNo, touch: this.touch, touchT: this.touchT, value: 0, times: [], speeds: [] };
      for (let i = 0; i < g; i++) { s.times.push(this.hitT[i]); s.speeds.push(this.hitV[i]); }
      if (g > 0) s.T = this.hitT[g - 1];
      if (n > 0 && g < n) { s.gap = this.gapTo(g); s.D = -s.gap; }
      else if (n > 0) {
        s.D = (cfg.C - s.T) / 1000 * (cfg.vref || 10) / 3.6;
        if (cfg.mode === 'hit' && this.touch < 0) { s.V = this.hitV[n - 1]; s.at = s.T; }
      }
      s.value = (1 - cfg.alpha) * s.D + cfg.alpha * s.V;
      return s;
    }
  }

  /** Whether score a is better than score b. */
  function better(a, b) {
    if (!b) return true;
    if (a.clean !== b.clean) return a.clean;
    if (a.hits !== b.hits) return a.hits > b.hits;
    if (a.value !== b.value) return a.value > b.value;
    return a.T < b.T;
  }

  // ================================================================== inputs inside the window
  /** The keys held at tick t, from a change list [{t, bits}] (ascending). */
  function stateAt(changes, t) {
    let lo = 0, hi = changes.length - 1, bits = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (changes[mid].t <= t) { bits = changes[mid].bits; lo = mid + 1; } else hi = mid - 1; }
    return bits;
  }

  /** The keys held at each tick from a to b (inclusive), one byte each. */
  function statesOf(changes, a, b) {
    const out = new Uint8Array(Math.max(0, b - a + 1));
    let i = 0, bits = 0;
    while (i < changes.length && changes[i].t <= a) bits = changes[i++].bits;
    for (let t = a; t <= b; t++) {
      while (i < changes.length && changes[i].t <= t) bits = changes[i++].bits;
      out[t - a] = bits;
    }
    return out;
  }

  /** A run's changes with the window [S, E] replaced by `win` (one byte per tick): the run a try drives. */
  function assemble(changes, S, E, win) {
    const out = [];
    let prev = 0;
    const push = (t, bits) => { if (bits !== prev) { out.push({ t, bits }); prev = bits; } };
    for (const c of changes) { if (c.t >= S) break; push(c.t, c.bits); }
    for (let t = S; t <= E; t++) push(t, win[t - S]);
    push(E + 1, stateAt(changes, E + 1));
    for (const c of changes) if (c.t > E + 1) push(c.t, c.bits);
    return out;
  }

  /**
   * The inputs a try may use, from the settings: each is a set of keys held together (bits as in
   * tas-inputs.js, 0 for none), the change types that may use it, and the ticks it may be used at (ranges
   * inside [S, E], merged). inputs: [{ bits, toggle, insert, shift, ranges: [[from, to], …] | null }, …]
   */
  function inputRules(inputs, S, E) {
    const out = [];
    for (const r of inputs || []) {
      let ranges = Array.isArray(r.ranges) && r.ranges.length ? r.ranges : [[S, E]];
      ranges = ranges.map(([a, b]) => [Math.max(S, Math.min(a, b) | 0), Math.min(E, Math.max(a, b) | 0)]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const [a, b] of ranges) { const last = merged[merged.length - 1]; if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
      out.push({ bits: r.bits & 31, toggle: !!r.toggle, insert: !!r.insert, shift: !!r.shift, ranges: merged });
    }
    return out;
  }

  /** Parses "2300-2500, 4100-4300" (ms) into ranges; '' → null (the whole window). Throws on nonsense. */
  function parseRanges(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    return t.split(/[,;\s]+/).filter(Boolean).map((part) => {
      const m = /^(\d+)\s*(?:-|–|\.\.)\s*(\d+)$/.exec(part);
      if (!m) throw new Error('"' + part + '" is not a range like 2300-2500');
      return [Number(m[1]), Number(m[2])];
    });
  }

  // ---------------------------------------------------------------- random numbers (seeded: sfc32)
  function rng(seed) {
    let s = seed >>> 0;
    const split = () => { s = (s + 0x9e3779b9) | 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
    let a = split(), b = split(), c = split(), d = split();
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

  /**
   * The changes a try makes, on the window in place. ctx (from mutationContext): S, E, `before` (keys
   * at S − 1) and `after` (keys at E + 1), the input rules, the type weights, the insert and shift lengths,
   * and the run's own changes just outside the window (a shift never moves an edge past the next change).
   * A change only ever puts a listed input where it may be used: a try never holds keys together that the
   * list does not have, except where the run itself already does.
   */
  function mutationContext(o) {
    const rules = inputRules(o.inputs, o.S, o.E);
    const types = [];
    for (const ty of TYPES) {
      const w = Math.max(0, Number(o.weights && o.weights[ty]) || 0);
      const list = rules.filter((r) => r[ty] && r.ranges.length);
      if (w > 0 && list.length) types.push({ type: ty, weight: w, rules: list });
    }
    let edgeBefore = -Infinity, edgeAfter = Infinity;
    for (const c of o.changes) { if (c.t < o.S) edgeBefore = c.t; else if (c.t > o.E + 1) { edgeAfter = c.t; break; } }
    return {
      S: o.S, E: o.E, before: stateAt(o.changes, o.S - 1), after: stateAt(o.changes, o.E + 1), rules, types,
      totalWeight: types.reduce((s, t) => s + t.weight, 0),
      ins: [Math.max(1, o.insert[0] | 0), Math.max(1, o.insert[1] | 0, o.insert[0] | 0)],
      sh: [Math.max(1, o.shift[0] | 0), Math.max(1, o.shift[1] | 0, o.shift[0] | 0)],
      per: [Math.max(1, o.per[0] | 0), Math.max(1, o.per[1] | 0, o.per[0] | 0)],
      edgeBefore, edgeAfter,
    };
  }

  /** Ticks a..b set to `bits`; whether any was different. */
  const setTo = (win, S, bits, a, b) => { let changed = false; for (let t = a; t <= b; t++) if (win[t - S] !== bits) { win[t - S] = bits; changed = true; } return changed; };
  /** The range of an input that holds ticks a..b, or null. */
  const rangeHolding = (rule, a, b) => { for (const r of rule.ranges) if (a >= r[0] && b <= r[1]) return r; return null; };

  /** One toggle: a whole line (a stretch of the same keys, from one change to the next) becomes this input, where it may be used. */
  function doToggle(win, ctx, rule, r) {
    const S = ctx.S, W = ctx.E - S + 1, lines = [];
    for (let i = 0; i < W;) {
      let j = i + 1;
      while (j < W && win[j] === win[i]) j++;
      if (win[i] !== rule.bits) for (const rg of rule.ranges) if (rg[0] <= S + j - 1 && rg[1] >= S + i) { lines.push(S + i, S + j - 1); break; }
      i = j;
    }
    if (!lines.length) return false;
    const k = randInt(r, 0, (lines.length >> 1) - 1), a = lines[2 * k], b = lines[2 * k + 1];
    let changed = false;
    for (const rg of rule.ranges) { const lo = Math.max(a, rg[0]), hi = Math.min(b, rg[1]); if (hi >= lo && setTo(win, S, rule.bits, lo, hi)) changed = true; }
    return changed;
  }

  /** One insert: this input held for a length from the insert range, all inside where it may be used. */
  function doInsert(win, ctx, rule, r) {
    let d = randInt(r, ctx.ins[0], ctx.ins[1]);
    let total = 0;
    for (const rg of rule.ranges) total += Math.max(0, rg[1] - rg[0] + 1 - d + 1);
    if (total <= 0) {
      // no allowed stretch is that long: the longest one there is
      d = Math.max(...rule.ranges.map((rg) => rg[1] - rg[0] + 1));
      if (d < ctx.ins[0]) return false;
      total = rule.ranges.reduce((s, rg) => s + Math.max(0, rg[1] - rg[0] + 1 - d + 1), 0);
    }
    let pick = randInt(r, 0, total - 1);
    for (const rg of rule.ranges) {
      const n = Math.max(0, rg[1] - rg[0] + 1 - d + 1);
      if (pick < n) { const a = rg[0] + pick; return setTo(win, ctx.S, rule.bits, a, a + d - 1); }
      pick -= n;
    }
    return false;
  }

  /**
   * One shift: where this input starts or ends, moved earlier or later by a length from the shift range —
   * whatever is next to it takes up the difference — never as far as the next change either way, and with
   * every tick it changes inside one of this input's times.
   */
  function doShift(win, ctx, rule, r) {
    const S = ctx.S, E = ctx.E, bits = rule.bits;
    const at = (t) => (t < S ? ctx.before : t > E ? ctx.after : win[t - S]);
    const changes = [], mine = [];
    for (let p = S; p <= E + 1; p++) { const x = at(p - 1), y = at(p); if (x !== y) { if (x === bits || y === bits) mine.push(changes.length); changes.push(p); } }
    if (!mine.length) return false;
    const i = mine[randInt(r, 0, mine.length - 1)], p = changes[i];
    const lo = i > 0 ? changes[i - 1] : ctx.edgeBefore, hi = i + 1 < changes.length ? changes[i + 1] : ctx.edgeAfter;
    const d = randInt(r, ctx.sh[0], ctx.sh[1]) * (r() < 0.5 ? -1 : 1);
    const q = p + d;
    if (!(q > lo && q < hi)) return false;
    const a = Math.min(p, q), b = Math.max(p, q) - 1;
    if (a < S || b > E || !rangeHolding(rule, a, b)) return false;
    return setTo(win, S, q > p ? at(p - 1) : at(p), a, b);
  }

  const DO = { toggle: doToggle, insert: doInsert, shift: doShift };

  /** One change of a type picked by weight, with an input that may take it (tries again a few times when a pick does not fit). */
  function mutateOnce(win, ctx, r) {
    if (!ctx.types.length) return false;
    for (let tries = 0; tries < 24; tries++) {
      let x = r() * ctx.totalWeight, ty = ctx.types[ctx.types.length - 1];
      for (const t of ctx.types) { if (x < t.weight) { ty = t; break; } x -= t.weight; }
      const rule = ty.rules[randInt(r, 0, ty.rules.length - 1)];
      if (DO[ty.type](win, ctx, rule, r)) return ty.type;
    }
    return false;
  }

  /** A try: the parent's window with 1..n changes (the changes-per-try range); null if nothing could change. */
  function mutate(parent, ctx, r, out) {
    const win = out || new Uint8Array(parent.length);
    win.set(parent);
    const n = randInt(r, ctx.per[0], ctx.per[1]);
    let made = 0;
    for (let i = 0; i < n; i++) if (mutateOnce(win, ctx, r)) made++;
    if (!made) return null;
    for (let i = 0; i < win.length; i++) if (win[i] !== parent[i]) return win;
    return null;           // the changes cancelled out
  }

  /** A 53-bit hash of a window (two 32-bit FNV-1a variants), to skip tries already made. */
  function hashWindow(win) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ win.length;
    for (let i = 0; i < win.length; i++) { h1 = Math.imul(h1 ^ win[i], 16777619); h2 = Math.imul(h2 ^ (win[i] + i), 2246822519); }
    return (h1 >>> 0) * 2097152 + ((h2 >>> 11) & 2097151);
  }

  // ---------------------------------------------------------------- the exhaustive search
  /**
   * Every pattern of the listed inputs, millisecond by millisecond: at each tick of the window, the run's own
   * keys or any listed input (with a change type ticked) that may be used then. The variables are the ticks
   * with more than one choice, earliest first, each with its choices (the run's own first). Pattern i is i
   * written in those bases, the last tick changing fastest: pattern 0 is the run itself.
   *
   * There is no limit on how many there are (a long window has more than any number holds exactly): the
   * count and the threads' blocks are BigInts, and a thread goes from one pattern to the next by its digits
   * (nextPattern), never by its number.
   */
  function exhaustiveVariables(ctx, base) {
    const vars = [];
    for (let t = ctx.S; t <= ctx.E; t++) {
      const own = base[t - ctx.S], options = [own];
      for (const rule of ctx.rules) {
        if (!(rule.toggle || rule.insert || rule.shift) || options.includes(rule.bits)) continue;
        if (rangeHolding(rule, t, t)) options.push(rule.bits);
      }
      if (options.length > 1) vars.push({ t, options });
    }
    return vars;
  }
  /** How many patterns the variables make: exactly (big, a BigInt), as a number (total: Infinity past 1e308) and in bits. */
  function patternCount(vars) {
    let big = 1n, bits = 0;
    for (const v of vars) { big *= BigInt(v.options.length); bits += Math.log2(v.options.length); }
    return { total: Number(big), big, bits };
  }
  /** The choice each variable takes in pattern i (a BigInt or a whole number; digits[j]), the last variable changing fastest. */
  function patternDigits(vars, i, digits) {
    let x = BigInt(i);
    for (let j = vars.length - 1; j >= 0; j--) { const n = BigInt(vars[j].options.length); digits[j] = Number(x % n); x /= n; }
    return digits;
  }
  /** The pattern after the one `digits` gives, in place. Returns the first variable that changed (-1: that was the last pattern). */
  function nextPattern(vars, digits) {
    for (let j = vars.length - 1; j >= 0; j--) {
      if (++digits[j] < vars[j].options.length) return j;
      digits[j] = 0;
    }
    return -1;
  }
  /** The window of the pattern `digits` gives, on the run's own (the ticks that do not vary stay as they are). */
  function patternWindow(base, S, vars, digits, out) {
    const win = out || new Uint8Array(base.length);
    win.set(base);
    for (let j = 0; j < vars.length; j++) win[vars[j].t - S] = vars[j].options[digits[j]];
    return win;
  }
  /** Pattern i of the variables (a BigInt or a whole number), on the run's own window. */
  function pattern(base, S, vars, i, out) { return patternWindow(base, S, vars, patternDigits(vars, i, new Int32Array(vars.length)), out); }
  /** The patterns [0, big) in T blocks for T threads, in order, as even as can be: [from, to) each, BigInts (none empty while T ≤ big). */
  function patternBlocks(big, T) {
    const n = BigInt(T), out = [];
    for (let j = 0n; j < n; j++) out.push([j * big / n, (j + 1n) * big / n]);
    return out;
  }

  return {
    KEYS, BIT, TYPES, CAR_CENTER, CAR_HALF, PART_SIZE, PART_ROTATIONS, POSE,
    rotate, newBox, fixBox, carBox, partBox, triggerBox, corners, overlaps, boxDistance, boxBetween, touchFraction,
    Tracker, better, stateAt, statesOf, assemble, inputRules, parseRanges, rng, randInt,
    mutationContext, mutateOnce, mutate, hashWindow, exhaustiveVariables, patternCount, patternDigits, nextPattern, patternWindow, pattern, patternBlocks,
  };
});
