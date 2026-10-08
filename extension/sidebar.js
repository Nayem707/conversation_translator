// Sidebar controller: wires the UI to the speech, audio, and translation modules.
import { LANGUAGES, languageName, normalizeLang, sameLanguage, bestMatch } from './languages.js';
import { translate, listProviders } from './translator.js';
import {
  SpeechSession,
  tts,
  isSpeechRecognitionSupported,
  supportsTrackRecognition,
  onDeviceAvailability,
  installOnDevice,
} from './speech.js';
import { captureDisplayAudio, detectCapabilities } from './audio.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'window' ? 'window' : 'embedded';
document.body.classList.add(`mode-${MODE}`);

const $ = (id) => document.getElementById(id);

const INPUTS = {
  mic: { label: 'Microphone (take turns)', short: 'Microphone', pill: 'Microphone active' },
  tab: { label: 'Tab audio (meeting participants)', short: 'Tab audio', pill: 'Tab audio captured' },
  system: { label: 'Screen / system audio (share picker)', short: 'Shared audio', pill: 'Screen/system audio captured' },
  captions: { label: 'Meeting captions (Meet / Teams / Zoom)', short: 'Meeting captions', pill: 'Reading captions' },
};

const STATE_LABELS = {
  idle: 'Idle',
  starting: 'Starting\u2026',
  listening: 'Listening',
  restarting: 'Listening',
  searching: 'Waiting for captions',
  reading: 'Reading captions',
};

const userLang = bestMatch(navigator.language, 'en-US');
const DEFAULTS = {
  srcLang: userLang,
  tgtLang: normalizeLang(userLang) === 'en' ? 'es-ES' : 'en-US',
  inputB: 'mic',
  provider: 'google',
  fallback: true,
  liveInterim: true,
  muteWhileSpeaking: true,
  onDevice: false,
  rate: 1,
  autoSpeakA: false,
  autoSpeakB: false,
  history: false,
  libreUrl: '',
  libreKey: '',
  mymemoryEmail: '',
};
const HISTORY_MAX = 200;

let settings = { ...DEFAULTS };
let tabId = null;
let log = [];
let capabilities = null;
let lastStatus = { active: false, label: '' };
let historyTimer = 0;
const speakers = {};

init();

async function init() {
  if (params.has('tab')) tabId = Number(params.get('tab'));
  else {
    try {
      tabId = (await chrome.runtime.sendMessage({ type: 'whoami' }))?.tabId ?? null;
    } catch {
      tabId = null;
    }
  }
  const stored = await chrome.storage.local.get(['settings', 'history']);
  settings = { ...DEFAULTS, ...stored.settings };
  if (!LANGUAGES.some((l) => l.code === settings.srcLang)) settings.srcLang = DEFAULTS.srcLang;
  if (!LANGUAGES.some((l) => l.code === settings.tgtLang)) settings.tgtLang = DEFAULTS.tgtLang;
  if (settings.history && Array.isArray(stored.history)) log = stored.history.slice(-HISTORY_MAX);

  speakers.A = createSpeaker('A');
  speakers.B = createSpeaker('B');
  bindGlobalControls();
  renderAll();

  if (MODE === 'window') {
    $('targetTab').textContent = tabId != null ? `Attached to tab #${tabId}` : 'Not attached to a tab (microphone only)';
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  addEventListener('pagehide', shutdown);

  capabilities = await detectCapabilities();
  renderCapabilities();
  updateOnDeviceStatus();
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

function spokenLang(id) {
  return id === 'A' ? settings.srcLang : settings.tgtLang;
}

function targetLang(id) {
  return id === 'A' ? settings.tgtLang : settings.srcLang;
}

function other(sp) {
  return speakers[sp.id === 'A' ? 'B' : 'A'];
}

function createSpeaker(id) {
  const node = $('speakerTemplate').content.firstElementChild.cloneNode(true);
  node.dataset.speaker = id;
  const role = (r) => node.querySelector(`[data-role="${r}"]`);
  const action = (a) => node.querySelector(`[data-action="${a}"]`);
  const sp = {
    id,
    node,
    el: {
      state: role('state'),
      input: role('input'),
      inputRow: role('inputRow'),
      meter: role('meter'),
      detected: role('detected'),
      translatedTo: role('translatedTo'),
      original: role('original'),
      translation: role('translation'),
      autoSpeak: role('autoSpeak'),
      notice: role('notice'),
      sub: node.querySelector('.speaker-sub'),
      start: action('start'),
      stop: action('stop'),
      speak: action('speak'),
    },
    source: null,
    kind: null,
    token: null,
    state: 'idle',
    last: null,
    interim: '',
    interimTranslation: '',
    pendingInterim: '',
    lastInterimSent: '',
    interimTimer: 0,
    interimCtrl: null,
    lastErrorCode: null,
  };

  node.querySelector('.badge').textContent = id;
  node.querySelector('.speaker-name').textContent = `Speaker ${id}`;
  const kinds = id === 'A' ? ['mic'] : ['mic', 'tab', 'system', 'captions'];
  for (const k of kinds) sp.el.input.add(new Option(INPUTS[k].label, k));
  sp.el.inputRow.hidden = id === 'A';
  if (id === 'B') sp.el.input.value = settings.inputB;
  sp.el.autoSpeak.checked = !!settings[`autoSpeak${id}`];

  sp.el.start.addEventListener('click', () => startSpeaker(sp));
  sp.el.stop.addEventListener('click', () => release(sp));
  sp.el.speak.addEventListener('click', () => speakEntry(sp.last, sp));
  sp.el.autoSpeak.addEventListener('change', () => {
    settings[`autoSpeak${id}`] = sp.el.autoSpeak.checked;
    saveSettings();
  });
  sp.el.input.addEventListener('change', () => {
    settings.inputB = sp.el.input.value;
    saveSettings();
    if (sp.source) release(sp);
    hideNotice(sp);
    renderSub(sp);
  });

  $('speakers').append(node);
  return sp;
}

function inputKind(sp) {
  return sp.id === 'A' ? 'mic' : settings.inputB;
}

function codeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function startSpeaker(sp) {
  release(sp);
  hideNotice(sp);
  const kind = inputKind(sp);
  if (kind === 'mic' && other(sp).kind === 'mic') release(other(sp)); // one microphone, take turns
  const h = makeHandlers(sp, kind);
  sp.kind = kind;
  setState(sp, 'starting');
  if (kind === 'mic') {
    setTimeout(() => {
      if (sp.token === h.token && sp.state === 'starting') {
        showNotice(sp, 'Waiting for microphone permission. Check the prompt near the address bar.', 'info', noticeActions('not-allowed'));
      }
    }, 2000);
  }
  try {
    const src = await createSource(kind, spokenLang(sp.id), h);
    if (sp.token !== h.token) {
      src?.stop();
      return;
    }
    sp.source = src;
  } catch (err) {
    if (sp.token !== h.token) return;
    release(sp);
    const { message, code } = explainStartError(err, kind);
    sp.lastErrorCode = code;
    showNotice(sp, message, 'error', noticeActions(code));
  }
}

function explainStartError(err, kind) {
  if (err?.name === 'NotAllowedError' && kind === 'system') {
    return {
      code: 'display-denied',
      message:
        'Screen sharing was cancelled or blocked. If this site blocks screen capture inside embedded panels, use the pop-out window.',
    };
  }
  if (err?.name === 'NotAllowedError') return { code: 'not-allowed', message: 'Permission was denied.' };
  return { code: err?.code || 'error', message: err?.message || String(err) };
}

function release(sp) {
  const src = sp.source;
  sp.source = null;
  sp.kind = null;
  sp.token = null;
  try {
    src?.stop();
  } catch {
    /* already stopped */
  }
  setState(sp, 'idle');
}

function makeHandlers(sp, kind) {
  const token = Symbol(sp.id);
  sp.token = token;
  const live = () => sp.token === token;
  const ignoreMic = () => kind === 'mic' && settings.muteWhileSpeaking && tts.speaking;
  return {
    token,
    onState: (state) => {
      if (!live()) return;
      if (state === 'idle') release(sp);
      else {
        if (state === 'listening' && sp.state === 'starting' && kind === 'mic') hideNotice(sp);
        setState(sp, state);
      }
    },
    onInterim: (text, who) => {
      if (!live() || ignoreMic()) return;
      showInterim(routeCaption(sp, kind, who), text);
    },
    onFinal: (text, confidence, who) => {
      if (!live() || ignoreMic()) return;
      handleFinal(routeCaption(sp, kind, who), text, { kind, who, confidence });
    },
    onError: (code, message, fatal) => {
      if (!live()) return;
      sp.lastErrorCode = code;
      showNotice(sp, message, fatal ? 'error' : 'warn', noticeActions(code));
      if (fatal) release(sp);
    },
    onLevel: (level) => {
      if (!live()) return;
      sp.el.meter.hidden = false;
      sp.el.meter.firstElementChild.style.width = `${Math.round(level * 100)}%`;
    },
    onInfo: (message) => {
      if (!live()) return;
      if (message) showNotice(sp, message, 'info');
      else hideNotice(sp);
    },
  };
}

// Meet/Teams label your own captions "You": show those under Speaker A.
function routeCaption(sp, kind, who) {
  return kind === 'captions' && sp.id === 'B' && /^you$/i.test(who || '') ? speakers.A : sp;
}

async function createSource(kind, lang, h) {
  if (kind === 'captions') return startCaptions(h);
  if (!isSpeechRecognitionSupported()) {
    throw codeError('Speech recognition (Web Speech API) is not available in this browser.', 'unsupported');
  }
  if (kind === 'mic') {
    const s = new SpeechSession({ lang, processLocally: settings.onDevice, ...h });
    s.start();
    return { stop: () => s.stop() };
  }
  if (!supportsTrackRecognition()) {
    throw codeError(
      'Transcribing captured audio needs Chrome 135 or newer (SpeechRecognition with a MediaStreamTrack). Use the microphone or meeting captions instead.',
      'no-track-sr',
    );
  }
  if (kind === 'system') {
    const cap = await captureDisplayAudio();
    const s = new SpeechSession({ lang, track: cap.track, processLocally: settings.onDevice, ...h });
    cap.onEnded(() => h.onError('track-ended', 'Screen/system audio sharing was stopped.', true));
    cap.startMeter(h.onLevel);
    s.start();
    return {
      stop: () => {
        s.stop();
        cap.stop();
      },
    };
  }
  if (kind === 'tab') return startTabAudio(lang, h);
  throw codeError(`Unknown input: ${kind}`, 'error');
}

async function startTabAudio(lang, h) {
  if (tabId == null) throw codeError('This translator window is not attached to a tab.', 'no-tab');
  const listener = (msg) => {
    if (msg?.type !== 'tab-audio:event' || msg.tabId !== tabId) return;
    if (msg.kind === 'interim') h.onInterim(msg.text);
    else if (msg.kind === 'final') h.onFinal(msg.text, msg.confidence);
    else if (msg.kind === 'state') h.onState(msg.state);
    else if (msg.kind === 'error') h.onError(msg.code, msg.message, msg.fatal);
    else if (msg.kind === 'level') h.onLevel(msg.level);
  };
  chrome.runtime.onMessage.addListener(listener);
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'tab-audio:start', tabId, lang, processLocally: settings.onDevice });
  } catch (err) {
    res = { error: err.message };
  }
  if (!res || res.error) {
    chrome.runtime.onMessage.removeListener(listener);
    throw codeError(res?.error || 'Tab audio capture failed.', res?.code || 'capture-failed');
  }
  // The offscreen worker stops capturing if this port closes (panel closed or reloaded).
  const port = chrome.runtime.connect({ name: `tab-audio:${tabId}` });
  return {
    stop: () => {
      chrome.runtime.onMessage.removeListener(listener);
      port.disconnect();
      chrome.runtime.sendMessage({ type: 'tab-audio:stop', tabId }).catch(() => {});
    },
  };
}

function startCaptions(h) {
  if (tabId == null) throw codeError('This translator window is not attached to a tab.', 'no-tab');
  const port = chrome.tabs.connect(tabId, { name: 'captions' });
  let closed = false;
  port.onMessage.addListener((m) => {
    if (m.type === 'status') {
      h.onState(m.state);
      h.onInfo(
        m.state === 'searching'
          ? `Waiting for ${m.platform} captions. Turn on captions (CC) in the meeting; they will be translated as they appear.`
          : null,
      );
    } else if (m.type === 'caption') {
      if (m.final) h.onFinal(m.text, null, m.speaker);
      else h.onInterim(m.text, m.speaker);
    } else if (m.type === 'unsupported') {
      h.onError('captions-unsupported', m.message, true);
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (closed) return;
    closed = true;
    h.onError('captions-disconnected', 'Could not reach the page script. Reload the meeting tab and try again.', true);
  });
  return {
    stop: () => {
      if (closed) return;
      closed = true;
      port.disconnect();
    },
  };
}

function noticeActions(code) {
  const actions = [];
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    actions.push({ label: 'Grant microphone access', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html#mic') }) });
  }
  if (MODE === 'embedded' && ['not-allowed', 'service-not-allowed', 'display-denied', 'audio-capture'].includes(code)) {
    actions.push({ label: 'Pop out window', run: popout });
  }
  if (code === 'no-track-sr' || code === 'not-invoked') {
    actions.push({ label: 'Use meeting captions instead', run: () => setInputB('captions') });
  }
  if (code === 'captions-unsupported') actions.push({ label: 'Use microphone', run: () => setInputB('mic') });
  return actions;
}

function setInputB(kind) {
  settings.inputB = kind;
  speakers.B.el.input.value = kind;
  saveSettings();
  release(speakers.B);
  hideNotice(speakers.B);
  renderSub(speakers.B);
}

function popout() {
  chrome.runtime.sendMessage({ type: 'popout', tabId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Utterances: detection -> translation -> speech
// ---------------------------------------------------------------------------

function showInterim(sp, text) {
  sp.interim = text;
  renderOriginal(sp);
  if (!text) {
    sp.interimTranslation = '';
    renderTranslation(sp);
    return;
  }
  scheduleInterimTranslation(sp, text);
}

function scheduleInterimTranslation(sp, text) {
  if (!settings.liveInterim || text.length < 4) return;
  sp.pendingInterim = text;
  if (sp.interimTimer) return;
  sp.interimTimer = setTimeout(async () => {
    sp.interimTimer = 0;
    const t = sp.pendingInterim;
    if (!t || t === sp.lastInterimSent || !sp.interim) return;
    sp.lastInterimSent = t;
    sp.interimCtrl?.abort();
    const ctrl = (sp.interimCtrl = new AbortController());
    try {
      const r = await translate(t, {
        source: 'auto',
        sourceHint: spokenLang(sp.id),
        target: targetLang(sp.id),
        ...translatorOptions(),
        fallback: false,
        signal: ctrl.signal,
      });
      if (ctrl === sp.interimCtrl && sp.interim) {
        sp.interimTranslation = r.text;
        renderTranslation(sp);
      }
    } catch {
      /* interim translation is best-effort */
    }
  }, 900);
}

function cancelInterim(sp) {
  clearTimeout(sp.interimTimer);
  sp.interimTimer = 0;
  sp.interimCtrl?.abort();
  sp.interimCtrl = null;
  sp.interim = sp.interimTranslation = sp.pendingInterim = sp.lastInterimSent = '';
}

async function handleFinal(sp, text, { kind, who }) {
  cancelInterim(sp);
  const entry = {
    id: crypto.randomUUID(),
    speaker: sp.id,
    who: kind === 'captions' ? who || '' : '',
    source: kind,
    original: text,
    spokenAs: kind === 'captions' ? null : spokenLang(sp.id),
    target: targetLang(sp.id),
    detected: null,
    translation: '',
    provider: '',
    error: '',
    pending: true,
    time: Date.now(),
  };
  log.push(entry);
  if (log.length > HISTORY_MAX) log.splice(0, log.length - HISTORY_MAX);
  sp.last = entry;
  renderEntry(entry);
  renderCard(sp);

  entry.detected = await detectLanguage(text);
  renderCard(sp);
  checkMismatch(sp, entry);

  await translateEntry(entry);
  renderEntry(entry);
  if (sp.last === entry) renderCard(sp);
  persistHistory();
  if (entry.translation && settings[`autoSpeak${sp.id}`]) speakEntry(entry, sp);
}

function translatorOptions() {
  return {
    provider: settings.provider,
    fallback: settings.fallback,
    config: { libreUrl: settings.libreUrl, libreKey: settings.libreKey, mymemoryEmail: settings.mymemoryEmail },
  };
}

async function translateEntry(entry) {
  entry.pending = true;
  entry.error = '';
  const det = entry.detected;
  if (det?.reliable && sameLanguage(det.code, entry.target)) {
    entry.translation = entry.original;
    entry.provider = 'Already in the target language';
    entry.pending = false;
    return;
  }
  try {
    const r = await translate(entry.original, {
      source: 'auto',
      sourceHint: det?.reliable ? det.code : entry.spokenAs || det?.code || 'en',
      target: entry.target,
      ...translatorOptions(),
    });
    entry.translation = r.text;
    entry.provider = r.providerLabel || '';
    if (r.detectedSource && (!det || !det.reliable)) {
      entry.detected = { code: r.detectedSource, percent: null, reliable: true, via: 'translation provider' };
    }
  } catch (err) {
    entry.translation = '';
    entry.error = `Translation failed: ${err.message}`;
  }
  entry.pending = false;
}

// Chrome's built-in language detector (CLD) runs locally on the recognised
// text. Fallback: Unicode script ranges.
async function detectLanguage(text) {
  try {
    const r = await chrome.i18n.detectLanguage(text);
    const top = r?.languages?.[0];
    if (top && top.language && top.language !== 'und') {
      return { code: normalizeLang(top.language), percent: top.percentage, reliable: !!r.isReliable, via: 'Chrome detector' };
    }
  } catch {
    /* fall through */
  }
  return detectByScript(text);
}

const SCRIPTS = [
  [/[\u0980-\u09FF]/, 'bn'], [/[\u0900-\u097F]/, 'hi'], [/[\u0A00-\u0A7F]/, 'pa'], [/[\u0A80-\u0AFF]/, 'gu'],
  [/[\u0B80-\u0BFF]/, 'ta'], [/[\u0C00-\u0C7F]/, 'te'], [/[\u0E00-\u0E7F]/, 'th'], [/[\u0590-\u05FF]/, 'he'],
  [/[\u0600-\u06FF]/, 'ar'], [/[\u0370-\u03FF]/, 'el'], [/[\u0400-\u04FF]/, 'ru'], [/[\uAC00-\uD7AF]/, 'ko'],
  [/[\u3040-\u30FF]/, 'ja'], [/[\u4E00-\u9FFF]/, 'zh-CN'],
];

function detectByScript(text) {
  for (const [re, code] of SCRIPTS) if (re.test(text)) return { code, percent: null, reliable: false, via: 'script' };
  return null;
}

function checkMismatch(sp, entry) {
  const det = entry.detected;
  if (!entry.spokenAs || !det?.reliable || sameLanguage(det.code, entry.spokenAs)) return;
  const otherSp = other(sp);
  const name = languageName(det.code);
  if (sameLanguage(det.code, spokenLang(otherSp.id))) {
    showNotice(sp, `That sounded like ${name}, which is Speaker ${otherSp.id}\u2019s language.`, 'warn', [
      { label: `Count it as Speaker ${otherSp.id}`, run: () => reassign(entry, otherSp) },
    ]);
    return;
  }
  const suggestion = bestMatch(det.code, null);
  showNotice(
    sp,
    `That sounded like ${name}, but Speaker ${sp.id} is set to ${languageName(entry.spokenAs)}. Recognition is only accurate in the selected language.`,
    'warn',
    suggestion ? [{ label: `Switch Speaker ${sp.id} to ${languageName(suggestion)}`, run: () => setSpokenLang(sp.id, suggestion) }] : [],
  );
}

async function reassign(entry, toSp) {
  const fromSp = speakers[entry.speaker];
  hideNotice(fromSp);
  entry.speaker = toSp.id;
  entry.target = targetLang(toSp.id);
  entry.spokenAs = spokenLang(toSp.id);
  if (fromSp.last === entry) {
    fromSp.last = null;
    renderCard(fromSp);
  }
  toSp.last = entry;
  renderEntry(entry);
  renderCard(toSp);
  await translateEntry(entry);
  renderEntry(entry);
  if (toSp.last === entry) renderCard(toSp);
  persistHistory();
}

async function speakEntry(entry, sp) {
  if (!entry?.translation) return;
  if (!tts.supported) {
    if (sp) showNotice(sp, 'Text-to-speech (speechSynthesis) is not available in this browser.', 'error');
    return;
  }
  const { voice } = await tts.speak(entry.translation, entry.target, { rate: settings.rate });
  if (!voice && sp) {
    showNotice(
      sp,
      `No installed voice for ${languageName(entry.target)}. The browser will try its default voice; add a voice for this language in your OS speech settings for correct pronunciation.`,
      'warn',
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  for (const sp of Object.values(speakers)) {
    renderSub(sp);
    renderCard(sp);
  }
  renderLog();
}

function renderSub(sp) {
  sp.el.sub.textContent = sp.id === 'A' ? 'You \u00B7 Microphone' : `Other person \u00B7 ${INPUTS[settings.inputB].short}`;
}

function setState(sp, state) {
  sp.state = state;
  sp.el.state.textContent = STATE_LABELS[state] || state;
  sp.el.state.className = `state${['listening', 'restarting', 'reading'].includes(state) ? ' on' : ''}${
    ['starting', 'searching'].includes(state) ? ' wait' : ''
  }`;
  const running = state !== 'idle';
  sp.el.start.disabled = running;
  sp.el.stop.disabled = !running;
  if (!running) {
    sp.el.meter.hidden = true;
    if (sp.interim) {
      cancelInterim(sp);
      renderOriginal(sp);
      renderTranslation(sp);
    }
  }
  updateIndicators();
}

function renderCard(sp) {
  renderMeta(sp);
  renderOriginal(sp);
  renderTranslation(sp);
  sp.el.speak.disabled = !sp.last?.translation;
}

function setMeta(dd, main, detail) {
  dd.textContent = main;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    dd.append(small);
  }
}

function renderMeta(sp) {
  const e = sp.last;
  const kind = sp.kind || inputKind(sp);
  const recognizer = kind === 'captions' ? 'from meeting captions' : `recognizer: ${spokenLang(sp.id)}`;
  if (!e) {
    setMeta(sp.el.detected, '\u2014', recognizer);
  } else if (!e.detected) {
    setMeta(sp.el.detected, e.pending ? 'Detecting\u2026' : 'Unknown', recognizer);
  } else {
    const d = e.detected;
    const pct = d.percent != null ? ` \u00B7 ${d.percent}%` : '';
    const caution = d.reliable ? '' : ' \u00B7 low confidence';
    setMeta(sp.el.detected, `${languageName(d.code)} (${d.code})`, `${d.via}${pct}${caution}`);
  }
  const target = e?.target || targetLang(sp.id);
  setMeta(sp.el.translatedTo, languageName(target), e?.provider || '');
}

function appendInterim(box, finalText, interim) {
  box.textContent = finalText || '';
  if (interim) {
    if (finalText) box.append(' ');
    const span = document.createElement('span');
    span.className = 'interim';
    span.textContent = interim;
    box.append(span);
  }
  box.scrollTop = box.scrollHeight;
}

function renderOriginal(sp) {
  appendInterim(sp.el.original, sp.last?.original, sp.interim);
}

function renderTranslation(sp) {
  const e = sp.last;
  const finalText = e ? e.translation || (e.pending ? 'Translating\u2026' : e.error) : '';
  appendInterim(sp.el.translation, finalText, sp.interim ? sp.interimTranslation : '');
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildEntry(e) {
  const li = document.createElement('li');
  li.dataset.speaker = e.speaker;
  li.dataset.id = e.id;
  const head = document.createElement('div');
  head.className = 'entry-head';
  const who = document.createElement('b');
  who.textContent = `Speaker ${e.speaker}${e.who ? ` \u00B7 ${e.who}` : ''}`;
  const meta = document.createElement('span');
  const from = e.detected?.code || (e.spokenAs ? normalizeLang(e.spokenAs) : '?');
  meta.textContent = `${formatTime(e.time)} \u00B7 ${from} \u2192 ${normalizeLang(e.target)}`;
  head.append(who, meta);
  if (e.translation) {
    const speak = document.createElement('button');
    speak.type = 'button';
    speak.dataset.speak = e.id;
    speak.title = 'Speak translation';
    speak.setAttribute('aria-label', 'Speak translation');
    speak.textContent = '\u{1F50A}';
    head.append(speak);
  }
  const orig = document.createElement('div');
  orig.className = 'orig';
  orig.textContent = e.original;
  li.append(head, orig);
  if (e.translation || e.pending) {
    const trans = document.createElement('div');
    trans.className = 'trans';
    trans.textContent = e.translation || 'Translating\u2026';
    li.append(trans);
  }
  if (e.error) {
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = e.error;
    li.append(err);
  }
  return li;
}

function renderLog() {
  const list = $('log');
  list.replaceChildren(...log.map(buildEntry));
  $('logEmpty').hidden = log.length > 0;
  list.scrollTop = list.scrollHeight;
}

function renderEntry(entry) {
  const list = $('log');
  const existing = list.querySelector(`li[data-id="${entry.id}"]`);
  const li = buildEntry(entry);
  if (existing) existing.replaceWith(li);
  else list.append(li);
  while (list.children.length > HISTORY_MAX) list.firstElementChild.remove();
  $('logEmpty').hidden = true;
  list.scrollTop = list.scrollHeight;
}

function showNotice(sp, message, level = 'warn', actions = []) {
  const box = sp.el.notice;
  box.className = `notice ${level}`;
  box.textContent = message;
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        hideNotice(sp);
        a.run();
      });
      row.append(b);
    }
    box.append(row);
  }
  box.hidden = false;
}

function hideNotice(sp) {
  sp.el.notice.hidden = true;
  sp.el.notice.textContent = '';
}

function updateIndicators() {
  const box = $('indicators');
  box.textContent = '';
  const labels = [];
  for (const sp of Object.values(speakers)) {
    if (!sp.kind || sp.state === 'idle') continue;
    const text = INPUTS[sp.kind].pill;
    labels.push(text);
    const pill = document.createElement('span');
    pill.className = `pill${sp.kind === 'captions' ? ' captions' : ''}`;
    pill.textContent = `${text} \u00B7 Speaker ${sp.id}`;
    box.append(pill);
  }
  const active = labels.length > 0;
  const label = labels.join(', ');
  if (active !== lastStatus.active || label !== lastStatus.label) {
    lastStatus = { active, label };
    chrome.runtime.sendMessage({ type: 'status', tabId, active, label }).catch(() => {});
  }
}

function renderCapabilities() {
  const c = capabilities;
  const mic = {
    granted: ['ok', 'Granted'],
    prompt: ['warn', 'Not decided yet. The browser asks on first use.'],
    denied: ['no', 'Blocked. Use \u201CPermissions & help\u201D to grant it.'],
  }[c.micPermission] || ['warn', 'Unknown in this context'];
  const items = [
    [
      c.speechRecognition ? 'ok' : 'no',
      'Microphone speech \u2192 text',
      c.speechRecognition ? 'Web Speech API. Needs microphone permission.' : 'Web Speech API is not available in this browser.',
    ],
    [mic[0], 'Microphone permission', mic[1]],
    [
      c.trackRecognition ? 'ok' : 'no',
      'Tab audio (participants in Meet / Teams / Zoom Web)',
      c.trackRecognition
        ? 'chrome.tabCapture + offscreen recognizer. Chrome requires clicking the toolbar icon (or Alt+Shift+T) on that tab first.'
        : 'Needs Chrome 135+ to transcribe captured audio.',
    ],
    [
      c.trackRecognition && c.displayCapture ? (c.systemAudioOS ? 'ok' : 'warn') : 'no',
      'Screen / system audio',
      !(c.trackRecognition && c.displayCapture)
        ? 'Not available here.'
        : c.systemAudioOS
          ? 'Via the share picker: choose \u201CEntire screen\u201D + \u201CShare system audio\u201D, or a tab + \u201CShare tab audio\u201D.'
          : 'This OS only allows sharing tab audio through the picker (no system audio).',
    ],
    ['warn', 'Meeting captions (experimental)', 'Reads captions that Meet / Teams / Zoom Web draw on screen. Turn captions on in the meeting.'],
    [
      'no',
      'Desktop apps & other programs',
      'An extension cannot hear the Zoom/Teams desktop apps directly. The only route is Windows/ChromeOS \u201CShare system audio\u201D.',
    ],
    [
      c.onDeviceApi ? 'ok' : 'warn',
      'On-device recognition',
      c.onDeviceApi ? 'Available in this browser (enable in Settings).' : 'Not exposed by this browser; recognition uses the browser\u2019s cloud service.',
    ],
    [c.tts ? 'ok' : 'no', 'Text-to-speech', c.tts ? 'speechSynthesis with your installed voices.' : 'speechSynthesis is not available.'],
  ];
  const list = $('caps');
  list.replaceChildren(
    ...items.map(([level, title, detail]) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `dot ${level}`;
      const body = document.createElement('div');
      body.textContent = title;
      const small = document.createElement('small');
      small.textContent = detail;
      body.append(small);
      li.append(dot, body);
      return li;
    }),
  );
}

async function updateOnDeviceStatus() {
  const el = $('onDeviceStatus');
  el.textContent = '';
  if (!settings.onDevice) return;
  if (!capabilities?.onDeviceApi) {
    el.textContent = 'This browser has no on-device recognition API; audio goes to the browser\u2019s cloud recognizer.';
    return;
  }
  const langs = [...new Set([settings.srcLang, settings.tgtLang])];
  const states = await Promise.all(langs.map((l) => onDeviceAvailability(l)));
  el.textContent = langs.map((l, i) => `${languageName(l)}: ${states[i]}`).join(' \u00B7 ');
  const missing = langs.filter((_, i) => states[i] === 'downloadable');
  if (missing.length) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn link';
    b.textContent = 'Download language packs';
    b.addEventListener('click', async () => {
      for (const l of missing) await Promise.resolve(installOnDevice(l)).catch(() => false);
      updateOnDeviceStatus();
    });
    el.append(' ', b);
  }
}

// ---------------------------------------------------------------------------
// Global controls & settings
// ---------------------------------------------------------------------------

function saveSettings() {
  chrome.storage.local.set({ settings }).catch(() => {});
}

function persistHistory() {
  if (!settings.history) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => chrome.storage.local.set({ history: log.slice(-HISTORY_MAX) }).catch(() => {}), 500);
}

function setSpokenLang(id, code) {
  if (id === 'A') settings.srcLang = code;
  else settings.tgtLang = code;
  $('srcLang').value = settings.srcLang;
  $('tgtLang').value = settings.tgtLang;
  onLanguagesChanged(id === 'A' ? ['A'] : ['B']);
}

function onLanguagesChanged(recognitionChanged) {
  saveSettings();
  for (const sp of Object.values(speakers)) renderMeta(sp);
  for (const id of recognitionChanged) {
    const sp = speakers[id];
    if (!sp.source) continue;
    if (sp.kind === 'mic' || sp.kind === 'tab') startSpeaker(sp);
    else if (sp.kind === 'system') showNotice(sp, 'Press Stop, then Start again to apply the new language to shared audio.', 'info');
  }
  updateOnDeviceStatus();
}

function bindGlobalControls() {
  for (const id of ['srcLang', 'tgtLang']) {
    const sel = $(id);
    for (const l of LANGUAGES) sel.add(new Option(l.name, l.code));
    sel.value = settings[id];
  }
  $('srcLang').addEventListener('change', (e) => {
    settings.srcLang = e.target.value;
    onLanguagesChanged(['A']);
  });
  $('tgtLang').addEventListener('change', (e) => {
    settings.tgtLang = e.target.value;
    onLanguagesChanged(['B']);
  });
  $('swapBtn').addEventListener('click', () => {
    [settings.srcLang, settings.tgtLang] = [settings.tgtLang, settings.srcLang];
    $('srcLang').value = settings.srcLang;
    $('tgtLang').value = settings.tgtLang;
    onLanguagesChanged(['A', 'B']);
  });

  const provider = $('provider');
  for (const p of listProviders()) provider.add(new Option(p.label, p.id));
  provider.value = settings.provider;
  provider.addEventListener('change', () => {
    settings.provider = provider.value;
    saveSettings();
  });

  for (const key of ['fallback', 'liveInterim', 'muteWhileSpeaking', 'onDevice']) {
    const box = $(key);
    box.checked = !!settings[key];
    box.addEventListener('change', () => {
      settings[key] = box.checked;
      saveSettings();
      if (key === 'onDevice') updateOnDeviceStatus();
    });
  }

  const rate = $('rate');
  rate.value = settings.rate;
  $('rateOut').textContent = `${Number(settings.rate).toFixed(1)}\u00D7`;
  rate.addEventListener('input', () => {
    settings.rate = Number(rate.value);
    $('rateOut').textContent = `${settings.rate.toFixed(1)}\u00D7`;
    saveSettings();
  });

  $('libreUrl').value = settings.libreUrl;
  $('libreKey').value = settings.libreKey;
  $('libreSave').addEventListener('click', saveLibre);
  $('mymemoryEmail').value = settings.mymemoryEmail;
  $('mymemoryEmail').addEventListener('change', (e) => {
    settings.mymemoryEmail = e.target.value.trim();
    saveSettings();
  });
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const history = $('historyToggle');
  history.checked = !!settings.history;
  history.addEventListener('change', () => {
    settings.history = history.checked;
    saveSettings();
    if (settings.history) persistHistory();
    else chrome.storage.local.remove('history');
  });

  $('clearBtn').addEventListener('click', () => {
    log = [];
    for (const sp of Object.values(speakers)) {
      cancelInterim(sp);
      sp.last = null;
      hideNotice(sp);
      renderCard(sp);
    }
    tts.cancel();
    renderLog();
    chrome.storage.local.remove('history');
  });

  $('log').addEventListener('click', (e) => {
    const id = e.target.closest('[data-speak]')?.dataset.speak;
    const entry = id && log.find((x) => x.id === id);
    if (entry) speakEntry(entry, speakers[entry.speaker]);
  });
}

async function saveLibre() {
  const status = $('libreStatus');
  const url = $('libreUrl').value.trim();
  settings.libreKey = $('libreKey').value.trim();
  if (!url) {
    settings.libreUrl = '';
    saveSettings();
    status.textContent = 'Cleared.';
    return;
  }
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    status.textContent = 'That is not a valid URL.';
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch (err) {
    status.textContent = `Could not request access: ${err.message}`;
    return;
  }
  if (!granted) {
    status.textContent = `Access to ${origin} was not granted, so the browser will block requests to it.`;
    return;
  }
  settings.libreUrl = url;
  saveSettings();
  status.textContent = `Saved. Select \u201CLibreTranslate\u201D as the provider to use ${origin}.`;
}

function onRuntimeMessage(msg) {
  if (msg?.type === 'tab-invoked' && msg.tabId === tabId) {
    const b = speakers.B;
    if (b.lastErrorCode === 'not-invoked') {
      b.lastErrorCode = null;
      showNotice(b, 'Tab audio is now authorized for this tab. Press Start Listening.', 'info');
    }
  }
}

function shutdown() {
  for (const sp of Object.values(speakers)) release(sp);
  tts.cancel();
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  if (lastStatus.active) chrome.runtime.sendMessage({ type: 'status', tabId, active: false }).catch(() => {});
}
