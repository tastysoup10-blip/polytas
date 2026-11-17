/*
 * The TAS window: the input editor (editor.js) and the bruteforce (brute.js), one at a time or both side by
 * side. This is what they share: which part shows (the tabs, Ctrl+1/2/3, and the game's "Open the input
 * editor" and "Open the bruteforce" keys), the split between them, staying on top of the game, the notice
 * that no Replay Editor is open, and which part keys go to when both show (the one you last clicked or typed in).
 *
 * Talks to the main process through window.tasWindow (electron/window-preload.js).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const host = window.tasWindow || { setOnTop() {}, onShow() {} };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
  };
  const VIEWS = ['inputs', 'brute', 'both'];
  const panes = $('panes');
  let view = VIEWS.includes(store.get('tas-window-view')) ? store.get('tas-window-view') : 'inputs';
  let lastPart = view === 'brute' ? 'brute' : 'inputs';
  const viewers = [];
  const detached = { inputs: false, brute: false };

  function setView(v) {
    if (!VIEWS.includes(v)) return;
    view = v;
    panes.className = 'view-' + v;
    for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('on', b.dataset.view === v);
    store.set('tas-window-view', v);
    if (v !== 'both') lastPart = v;
    paintDetached();
    for (const fn of viewers) { try { fn(v); } catch (e) { console.error(e); } }
  }
  const shows = (part) => view === 'both' || view === part;
  /** Whether keys go to a part: it shows, and with both showing, the keyboard is in it (or it was clicked last). */
  function active(part) {
    if (!shows(part)) return false;
    if (view !== 'both') return true;
    const a = document.activeElement, pane = a && a.closest ? a.closest('.pane') : null;
    if (pane) return pane.id === (part === 'inputs' ? 'paneInputs' : 'paneBrute');
    return lastPart === part;
  }
  function paintDetached() { $('detached').classList.toggle('hidden', !((shows('inputs') && detached.inputs) || (shows('brute') && detached.brute))); }

  for (const b of document.querySelectorAll('#tabs .tab')) b.addEventListener('click', () => setView(b.dataset.view));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[123]$/.test(e.code)) { e.preventDefault(); e.stopPropagation(); setView(VIEWS[Number(e.code.slice(5)) - 1]); }
  }, true);
  $('paneInputs').addEventListener('mousedown', () => { lastPart = 'inputs'; }, true);
  $('paneBrute').addEventListener('mousedown', () => { lastPart = 'brute'; }, true);
  // the game's keys: its part shows (both stay both), and gets the keys
  host.onShow((part) => {
    if (!VIEWS.includes(part) || part === 'both') return;
    if (view !== 'both') setView(part);
    lastPart = part;
    if (part === 'inputs') $('text').focus();
    else if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#paneInputs')) document.activeElement.blur();
  });

  // on top of the game (it was each window's own setting before they were one)
  const onTop = $('onTop');
  let top = store.get('tas-window-on-top');
  if (top == null) { let ed = {}; try { ed = JSON.parse(store.get('tas-v1-editor') || '{}'); } catch { } top = (store.get('tas-brute-on-top') || ed.onTop) ? '1' : ''; }
  onTop.checked = top === '1';
  host.setOnTop(onTop.checked);
  onTop.addEventListener('change', () => { host.setOnTop(onTop.checked); store.set('tas-window-on-top', onTop.checked ? '1' : ''); });

  // the split, with both showing: drag it (double-click: back to 38 %)
  const split = $('split');
  const share = Number(store.get('tas-window-split'));
  if (share > 0.1 && share < 0.9) document.documentElement.style.setProperty('--split', (share * 100).toFixed(2) + '%');
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    split.classList.add('drag');
    const r = panes.getBoundingClientRect();
    const move = (ev) => {
      const x = Math.max(300, Math.min(r.width - 420, ev.clientX - r.left));
      document.documentElement.style.setProperty('--split', (100 * x / r.width).toFixed(2) + '%');
      store.set('tas-window-split', String(x / r.width));
      window.dispatchEvent(new Event('resize'));
    };
    const up = () => { split.classList.remove('drag'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  split.addEventListener('dblclick', () => { document.documentElement.style.setProperty('--split', '38%'); store.set('tas-window-split', ''); window.dispatchEvent(new Event('resize')); });

  window.TASWindow = {
    get view() { return view; }, setView, shows, active,
    /** fn(view) whenever which part shows changes. */
    onView(fn) { viewers.push(fn); },
    /** A part says whether it has a Replay Editor to work on (the notice shows while a showing part has none). */
    detached(part, on) { detached[part] = !!on; paintDetached(); },
    setTitle(track) { document.title = 'TAS' + (track ? ' — ' + track : ''); },
  };
  setView(view);
})();
