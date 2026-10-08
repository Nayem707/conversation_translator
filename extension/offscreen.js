// Offscreen document: consumes the tabCapture stream, keeps the tab audible
// (Chrome mutes captured tabs), and transcribes it with SpeechRecognition.
// It runs outside the captured tab, so replaying the audio cannot feed back
// into the capture. Results are broadcast as 'tab-audio:event' messages.
import { SpeechSession, supportsTrackRecognition } from './speech.js';
import { captureTabStream } from './audio.js';

const sessions = new Map();
let idleTimer = 0;

// Grace period so a stop immediately followed by a restart reuses this document.
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!sessions.size) chrome.runtime.sendMessage({ type: 'offscreen:idle' }).catch(() => {});
  }, 3000);
}

function emit(tabId, data) {
  chrome.runtime.sendMessage({ type: 'tab-audio:event', tabId, ...data }).catch(() => {});
}

async function start({ tabId, streamId, lang, processLocally }) {
  clearTimeout(idleTimer);
  stop(tabId, false);
  if (!supportsTrackRecognition()) {
    throw new Error(
      'This browser cannot transcribe captured audio (SpeechRecognition with a MediaStreamTrack needs Chrome 135+). Tab audio was not captured.',
    );
  }
  const capture = await captureTabStream(streamId);
  const speech = new SpeechSession({
    lang,
    track: capture.track,
    processLocally,
    onInterim: (text) => emit(tabId, { kind: 'interim', text }),
    onFinal: (text, confidence) => emit(tabId, { kind: 'final', text, confidence }),
    onState: (state) => emit(tabId, { kind: 'state', state }),
    onError: (code, message, fatal) => {
      emit(tabId, { kind: 'error', code, message, fatal });
      if (fatal) stop(tabId, false);
    },
  });
  sessions.set(tabId, { capture, speech });
  capture.onEnded(() => {
    emit(tabId, { kind: 'error', code: 'track-ended', message: 'Tab audio capture ended (tab closed or navigated).', fatal: true });
    stop(tabId);
  });
  capture.startMeter((level) => emit(tabId, { kind: 'level', level }), 250);
  speech.start();
}

function stop(tabId, notify = true) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  s.speech.stop();
  s.capture.stop();
  if (notify) emit(tabId, { kind: 'state', state: 'idle' });
  if (!sessions.size) scheduleIdle();
}

// Each sidebar holds a port while it owns a capture; if the sidebar goes away
// (panel closed, page reloaded, window closed) the capture stops with it.
chrome.runtime.onConnect.addListener((port) => {
  const m = /^tab-audio:(\d+)$/.exec(port.name);
  if (!m) return;
  const tabId = Number(m[1]);
  const session = sessions.get(tabId);
  if (!session) {
    port.disconnect();
    return;
  }
  session.port = port;
  port.onDisconnect.addListener(() => {
    if (sessions.get(tabId)?.port === port) stop(tabId);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'tab-audio:start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (err) => {
        console.warn('[offscreen] tab audio start failed:', err);
        stop(msg.tabId, false);
        if (!sessions.size) scheduleIdle();
        sendResponse({ error: err.message || String(err) });
      },
    );
    return true;
  }
  if (msg.type === 'tab-audio:stop') {
    stop(msg.tabId);
    sendResponse({ ok: true });
  }
});
