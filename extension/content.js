// Content script: floating button + draggable panel hosting the extension's
// sidebar.html in an iframe, plus an opt-in reader for meeting captions.
// Everything lives in a closed shadow root so page CSS cannot leak in.
(() => {
  'use strict';
  if (globalThis.__liveTranslatorContent || window.top !== window) return;
  globalThis.__liveTranslatorContent = true;

  const SIDEBAR_URL = chrome.runtime.getURL('sidebar.html');
  const UI_KEY = 'ui';
  const ui = { fab: { right: 20, bottom: 96 }, panel: null };

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3.5 3 6 6 7.5M11 5c-.8 3.6-3.4 6.5-7 8"/><path d="M13 21l4-9 4 9M14.5 18h5"/></svg>`;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab {
      position: fixed; width: 48px; height: 48px; border-radius: 50%; border: 0; padding: 0;
      display: grid; place-items: center; color: #fff; cursor: grab; touch-action: none;
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      box-shadow: 0 6px 18px rgba(15, 23, 42, .28); transition: transform .15s ease, opacity .15s ease;
    }
    .fab:hover { transform: scale(1.06); }
    .fab:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 2px; }
    .fab svg { width: 24px; height: 24px; pointer-events: none; }
    .fab .dot {
      position: absolute; top: 1px; right: 1px; width: 13px; height: 13px; border-radius: 50%;
      background: #ef4444; border: 2px solid #fff; display: none;
    }
    .fab.live .dot { display: block; animation: pulse 1.4s ease-in-out infinite; }
    .panel {
      position: fixed; width: 390px; height: min(720px, calc(100vh - 32px));
      min-width: 320px; min-height: 240px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
      display: flex; flex-direction: column; overflow: hidden; resize: both;
      background: #fff; border-radius: 14px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, .30), 0 0 0 1px rgba(15, 23, 42, .08);
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a;
    }
    .panel.min { height: auto !important; min-height: 0; resize: none; }
    .panel.min .body { flex: 0 0 0; height: 0; visibility: hidden; }
    .bar {
      display: flex; align-items: center; gap: 6px; padding: 7px 6px 7px 12px; flex: none;
      color: #fff; background: linear-gradient(135deg, #4f46e5, #7c3aed);
      cursor: grab; user-select: none; touch-action: none;
    }
    .bar.dragging, .fab.dragging { cursor: grabbing; }
    .title { font-weight: 600; letter-spacing: .2px; }
    .live {
      font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
      background: #ef4444; animation: pulse 1.4s ease-in-out infinite;
    }
    .live[hidden] { display: none; }
    .spacer { flex: 1; }
    .bar button {
      width: 28px; height: 28px; border: 0; border-radius: 7px; cursor: pointer;
      background: transparent; color: #fff; font: 600 15px/1 system-ui, sans-serif;
    }
    .bar button:hover { background: rgba(255, 255, 255, .18); }
    .bar button:focus-visible { outline: 2px solid #fff; }
    .body { flex: 1; position: relative; }
    .body.dragging iframe { pointer-events: none; }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: transparent; }
    @keyframes pulse { 50% { opacity: .55; } }
    @media (prefers-color-scheme: dark) { .panel { background: #0f172a; color: #e2e8f0; } }
  `;

  let host;
  let root;
  let fab;
  let panel = null;
  let panelBody = null;
  let liveBadge = null;
  let status = { active: false, label: '' };

  // Listeners must exist synchronously: the toolbar click may arrive right after injection.
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.runtime.onConnect.addListener(onConnect);
  mount();
  chrome.storage.local
    .get(UI_KEY)
    .then((saved) => {
      if (!saved[UI_KEY]) return;
      Object.assign(ui, saved[UI_KEY]);
      placeFab();
      placePanel();
    })
    .catch(() => {});

  function saveUi() {
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
  }

  function mount() {
    host = document.createElement('live-translator-host');
    host.style.cssText =
      'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    fab = document.createElement('button');
    fab.className = 'fab';
    fab.type = 'button';
    fab.title = 'Live Translator (drag to move)';
    fab.setAttribute('aria-label', 'Open Live Translator');
    fab.innerHTML = `${ICON}<span class="dot"></span>`;
    root.append(style, fab);
    placeFab();

    let start;
    makeDraggable(fab, {
      onStart: () => (start = { ...ui.fab }),
      onMove: (dx, dy) => {
        ui.fab.right = clamp(start.right - dx, 4, innerWidth - 52);
        ui.fab.bottom = clamp(start.bottom - dy, 4, innerHeight - 52);
        placeFab();
      },
      onEnd: saveUi,
      onClick: onFabClick,
    });
    // Keyboard activation produces a click with detail === 0.
    fab.addEventListener('click', (e) => e.detail === 0 && onFabClick());
    document.documentElement.append(host);
  }

  function placeFab() {
    fab.style.right = `${clamp(ui.fab.right, 4, Math.max(4, innerWidth - 52))}px`;
    fab.style.bottom = `${clamp(ui.fab.bottom, 4, Math.max(4, innerHeight - 52))}px`;
  }

  function onFabClick() {
    if (!panel) openPanel();
    else setMinimized(!panel.classList.contains('min'));
  }

  function openPanel() {
    if (panel) {
      setMinimized(false);
      return;
    }
    panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Live Translator');

    const bar = document.createElement('header');
    bar.className = 'bar';
    bar.innerHTML = `
      <span class="title">Live Translator</span>
      <span class="live" hidden>\u25CF LIVE</span>
      <span class="spacer"></span>
      <button type="button" data-nodrag data-act="popout" title="Pop out into a separate window" aria-label="Pop out">\u29C9</button>
      <button type="button" data-nodrag data-act="min" title="Minimize (keeps listening)" aria-label="Minimize">\u2013</button>
      <button type="button" data-nodrag data-act="close" title="Close (stops listening)" aria-label="Close">\u2715</button>`;
    liveBadge = bar.querySelector('.live');

    panelBody = document.createElement('div');
    panelBody.className = 'body';
    const frame = document.createElement('iframe');
    frame.src = SIDEBAR_URL;
    frame.title = 'Live Translator';
    frame.allow = 'microphone; display-capture; autoplay';
    panelBody.append(frame);
    panel.append(bar, panelBody);
    root.append(panel);
    placePanel();
    renderStatus();

    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'min') setMinimized(!panel.classList.contains('min'));
      else if (act === 'close') closePanel();
      else if (act === 'popout') chrome.runtime.sendMessage({ type: 'popout' }).catch(() => {});
    });

    let start;
    makeDraggable(bar, {
      onStart: () => {
        const r = panel.getBoundingClientRect();
        start = { left: r.left, top: r.top };
        panelBody.classList.add('dragging');
      },
      onMove: (dx, dy) => {
        ui.panel = { left: start.left + dx, top: start.top + dy };
        placePanel();
      },
      onEnd: () => {
        panelBody?.classList.remove('dragging');
        saveUi();
      },
      onClick: () => panelBody?.classList.remove('dragging'),
    });
    addEventListener('resize', onResize, { passive: true });
  }

  function placePanel() {
    if (!panel) return;
    if (!ui.panel) {
      panel.style.left = '';
      panel.style.right = '16px';
      panel.style.top = '16px';
      return;
    }
    const w = panel.offsetWidth || 390;
    ui.panel.left = clamp(ui.panel.left, 8 - w + 80, innerWidth - 80);
    ui.panel.top = clamp(ui.panel.top, 0, innerHeight - 40);
    panel.style.right = 'auto';
    panel.style.left = `${ui.panel.left}px`;
    panel.style.top = `${ui.panel.top}px`;
  }

  function onResize() {
    placeFab();
    placePanel();
  }

  function setMinimized(min) {
    panel?.classList.toggle('min', min);
  }

  function closePanel() {
    if (!panel) return;
    removeEventListener('resize', onResize);
    panel.remove(); // unloading the iframe stops every recognition/capture it owns
    panel = panelBody = liveBadge = null;
    setStatus({ active: false, label: '' });
  }

  function setStatus(next) {
    status = next;
    renderStatus();
  }

  function renderStatus() {
    fab.classList.toggle('live', status.active);
    fab.title = status.active ? `Live Translator \u2013 ${status.label || 'capturing audio'}` : 'Live Translator (drag to move)';
    if (liveBadge) {
      liveBadge.hidden = !status.active;
      liveBadge.title = status.label;
    }
  }

  function onMessage(msg) {
    switch (msg?.type) {
      case 'open':
        openPanel();
        break;
      case 'close-panel':
        closePanel();
        break;
      case 'status':
        setStatus({ active: !!msg.active, label: msg.label || '' });
        break;
    }
  }

  function makeDraggable(handle, { onStart, onMove, onEnd, onClick }) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('[data-nodrag]')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      onStart?.();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) handle.classList.add('dragging');
        moved = true;
        onMove(dx, dy);
      };
      const up = (ev) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        handle.classList.remove('dragging');
        if (moved) onEnd?.();
        else if (ev.type === 'pointerup') onClick?.();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  // ---------------------------------------------------------------------------
  // Meeting captions reader (experimental).
  // Reads the captions the meeting platform itself renders on screen. Class
  // names are obfuscated and change without notice, so selectors are a
  // best-effort list with a generic text fallback.
  // ---------------------------------------------------------------------------
  const ADAPTERS = [
    {
      id: 'meet',
      name: 'Google Meet',
      test: (h) => h === 'meet.google.com',
      containers: ['div[role="region"][aria-label*="aption" i]', 'div[jsname="dsyhDe"]', 'div.a4cQT', 'div.iOzk7'],
      text: '.ygicle, div[jsname="tgaKEf"], .bh44bd',
      speaker: '.NWpY1d, .zs7s8d, .KcIKyf',
    },
    {
      id: 'teams',
      name: 'Microsoft Teams',
      test: (h) => /(^|\.)teams\.(microsoft\.com|live\.com|cloud\.microsoft)$/.test(h),
      containers: [
        '[data-tid="closed-caption-v2-window-wrapper"]',
        '[data-tid="closed-caption-renderer-wrapper"]',
        '[data-tid="closed-captions-renderer"]',
      ],
      text: '[data-tid="closed-caption-text"]',
      speaker: '[data-tid="author"]',
    },
    {
      id: 'zoom',
      name: 'Zoom Web',
      test: (h) => /(^|\.)zoom\.us$/.test(h),
      containers: ['#live-transcription-subtitle', '.live-transcription-subtitle__box', '.lt-full-transcript__list'],
      text: '.live-transcription-subtitle__item, .lt-full-transcript__message',
      speaker: '.lt-full-transcript__display-name',
    },
  ];

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function searchRoots() {
    const roots = [document];
    // Zoom's web client renders the meeting in a same-origin iframe.
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument) roots.push(f.contentDocument);
      } catch {
        /* cross-origin */
      }
    }
    return roots;
  }

  function findNear(el, selector, depth = 5) {
    for (let node = el; node && depth-- > 0; node = node.parentElement) {
      const hit = node.querySelector(selector);
      if (hit && !hit.contains(el)) return hit;
    }
    return null;
  }

  class CaptionReader {
    constructor(port, adapter) {
      this.port = port;
      this.adapter = adapter;
      this.container = null;
      this.observer = null;
      this.current = null;
      this.committed = new WeakMap();
      this.findTimer = 0;
      this.idleTimer = 0;
      this.readTimer = 0;
    }

    post(msg) {
      try {
        this.port.postMessage(msg);
      } catch {
        this.stop();
      }
    }

    start() {
      this.post({ type: 'status', state: 'searching', platform: this.adapter.name });
      this.find();
    }

    // Light polling (1.5 s) only while waiting for captions to be switched on;
    // stops as soon as the caption container exists.
    find() {
      for (const r of searchRoots()) {
        for (const sel of this.adapter.containers) {
          const c = r.querySelector(sel);
          if (c) {
            this.attach(c);
            return;
          }
        }
      }
      this.findTimer = setTimeout(() => this.find(), 1500);
    }

    attach(container) {
      this.container = container;
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(container, { childList: true, subtree: true, characterData: true });
      this.post({ type: 'status', state: 'reading', platform: this.adapter.name });
      this.schedule();
    }

    schedule() {
      if (!this.readTimer) this.readTimer = setTimeout(() => this.read(), 150);
    }

    entries() {
      const c = this.container;
      const nodes = c.querySelectorAll(this.adapter.text);
      if (nodes.length) {
        return [...nodes].map((el) => ({
          el,
          text: clean(el.textContent),
          speaker: clean(findNear(el, this.adapter.speaker)?.textContent),
        }));
      }
      return [{ el: c, text: clean(c.innerText).slice(-500), speaker: '' }];
    }

    delta(entry) {
      const done = this.committed.get(entry.el) || '';
      let t = entry.text;
      if (done) {
        if (t.startsWith(done)) t = t.slice(done.length);
        else {
          const tail = done.slice(-40);
          const i = t.lastIndexOf(tail);
          if (i >= 0) t = t.slice(i + tail.length);
        }
      }
      return t.trim();
    }

    read() {
      this.readTimer = 0;
      if (!this.container?.isConnected) {
        this.detach();
        this.post({ type: 'status', state: 'searching', platform: this.adapter.name });
        this.find();
        return;
      }
      const list = this.entries().filter((e) => e.text);
      const last = list[list.length - 1];
      if (!last) return;
      if (this.current && this.current.el !== last.el) this.commit();
      this.current = last;
      const text = this.delta(last);
      if (!text) return;
      this.post({ type: 'caption', final: false, text, speaker: last.speaker });
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.commit(), 1500);
    }

    commit() {
      clearTimeout(this.idleTimer);
      const e = this.current;
      if (!e) return;
      const text = this.delta(e);
      if (text) this.post({ type: 'caption', final: true, text, speaker: e.speaker });
      this.committed.set(e.el, e.text);
    }

    detach() {
      this.observer?.disconnect();
      this.observer = null;
      this.container = null;
      this.current = null;
      clearTimeout(this.idleTimer);
      clearTimeout(this.readTimer);
      this.readTimer = 0;
    }

    stop() {
      clearTimeout(this.findTimer);
      this.detach();
    }
  }

  function onConnect(port) {
    if (port.name !== 'captions') return;
    const adapter = ADAPTERS.find((a) => a.test(location.hostname));
    if (!adapter) {
      port.postMessage({
        type: 'unsupported',
        message: 'Caption reading is only available on Google Meet, Microsoft Teams and Zoom Web.',
      });
      return;
    }
    const reader = new CaptionReader(port, adapter);
    port.onDisconnect.addListener(() => reader.stop());
    reader.start();
  }
})();
