/*
 * PolyTrack TAS — which physics a simulation worker loads. Not loaded on its own: tools/patches.mjs puts it at
 * the top of the game's simulation worker, and passes this to the game's own PolyTrackPhysics().
 *
 * A worker the bruteforce starts (named "tas-brute") loads polytrack_physics_tas.wasm: the game's physics, the
 * same code, which also notes every 4 KB page of memory it writes (tools/wasm-marks.mjs). Every other worker —
 * the game's own simulation, the Replay Editor's — loads the game's polytrack_physics.wasm as always.
 *
 * The physics' own JavaScript can write into its memory without a note: printing (fd_write writes how much was
 * printed) and C++ exceptions. A call to any of it sets __tasJsTouched, and the bruteforce then puts the whole
 * memory back. Two never write into memory and are left alone: growing it (the new pages are zero) and the clock.
 */
function __tasPhysicsOptions() {
  if (self.name !== 'tas-brute') return void 0;
  const QUIET = { f: 'emscripten_resize_heap', h: 'emscripten_date_now' };
  return {
    instantiateWasm(imports, done) {
      const own = imports.a, mine = {};
      self.__tasJsCalls = 0;
      for (const k of Object.keys(own)) {
        const fn = own[k];
        mine[k] = typeof fn !== 'function' || QUIET[k] ? fn : function () { self.__tasJsTouched = !0; self.__tasJsCalls++; return fn.apply(this, arguments); };
      }
      const load = (file, wrapped) => fetch(file, { credentials: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error(r.status + ' ' + r.url); return r.arrayBuffer(); })
        .then((b) => WebAssembly.instantiate(b, wrapped ? { a: mine } : imports));
      load('polytrack_physics_tas.wasm', !0)
        .then((r) => {
          if (!r.instance.exports.tasmarks || !r.instance.exports.tassp) throw new Error('polytrack_physics_tas.wasm has no page marks');
          self.__tasPhys = r.instance.exports; done(r.instance, r.module);
        })
        .catch((x) => {
          // the game's own physics, so the worker still works; the bruteforce then says why it cannot run
          self.__tasPhys = null; self.__tasPhysError = String((x && x.message) || x);
          load('polytrack_physics.wasm', !1).then((r) => done(r.instance, r.module));
        });
      return {};
    },
  };
}
