// Speech-to-text (SpeechRecognition) and text-to-speech (speechSynthesis) wrappers.
import { baseOf, normalizeLang } from './languages.js';

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
const noop = () => {};

export function isSpeechRecognitionSupported() {
  return !!SR;
}

function chromiumMajor() {
  const brand = navigator.userAgentData?.brands?.find((b) => b.brand === 'Chromium');
  if (brand) return parseInt(brand.version, 10) || 0;
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// SpeechRecognition.start(MediaStreamTrack) shipped in Chrome 135. Older versions
// silently ignore the argument and use the microphone instead, so gate on version
// rather than risk transcribing the wrong source.
export function supportsTrackRecognition() {
  return !!SR && chromiumMajor() >= 135;
}

const ERROR_TEXT = {
  unsupported: 'Speech recognition (Web Speech API) is not available in this browser.',
  'not-allowed':
    'Microphone access was blocked for the translator. Grant access from the extension page, or use the pop-out window if this site blocks embedded microphones.',
  'service-not-allowed': 'The browser speech service is not allowed here (disabled by policy or unavailable).',
  'audio-capture': 'No microphone was found, or it is in exclusive use by another application.',
  network: 'The speech service could not be reached. Chrome\u2019s recognizer needs an internet connection unless on-device recognition is available.',
  'language-not-supported': 'The speech recognizer does not support this language.',
  aborted: 'Recognition was interrupted. Chrome may allow only one recognition session at a time.',
  'track-ended': 'The captured audio stream ended.',
  'restart-loop': 'Recognition keeps stopping immediately. Check the microphone/audio source and language.',
  'start-failed': 'Recognition could not start.',
};

export function describeSpeechError(code, detail) {
  const base = ERROR_TEXT[code] || `Speech recognition error: ${code}.`;
  return detail ? `${base} (${detail})` : base;
}

const FATAL = new Set([
  'unsupported',
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'language-not-supported',
  'bad-grammar',
  'phrases-not-supported',
  'start-failed',
  'track-ended',
]);

const words = (s) => s.split(/\s+/).filter(Boolean);
const PAUSE_COMMIT_MS = 1200;
const MAX_INTERIM_WORDS = 40;

/**
 * A continuous recognition session that survives Chrome's periodic auto-stop.
 * Pass `track` (a live audio MediaStreamTrack) to transcribe something other
 * than the default microphone (Chrome 135+).
 *
 * In continuous mode Chrome may keep one interim result growing for a long
 * time without ever marking it final, so interim text is committed locally
 * after a pause or once it gets long. `#forced` counts words already
 * committed that Chrome will later repeat at the start of its own finals.
 */
export class SpeechSession {
  #rec = null;
  #active = false;
  #quickEnds = 0;
  #startedAt = 0;
  #restartTimer = 0;
  #stopTimer = 0;
  #lastError = null;
  #forced = 0;
  #pending = '';
  #pauseTimer = 0;

  constructor({ lang, track = null, processLocally = false, onInterim, onFinal, onState, onError }) {
    this.lang = lang;
    this.track = track;
    this.processLocally = processLocally;
    this.cb = {
      onInterim: onInterim || noop,
      onFinal: onFinal || noop,
      onState: onState || noop,
      onError: onError || noop,
    };
  }

  get active() {
    return this.#active;
  }

  start() {
    if (!SR) {
      this.#fail('unsupported');
      return false;
    }
    if (this.#active) return true;
    this.#active = true;
    this.#quickEnds = 0;
    this.#forced = 0;
    this.#pending = '';
    this.cb.onState('starting');
    this.#spawn();
    return this.#active;
  }

  stop() {
    this.#active = false;
    clearTimeout(this.#restartTimer);
    const rec = this.#rec;
    if (!rec) {
      this.cb.onState('idle');
      return;
    }
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
    // If 'end' never arrives, force cleanup.
    this.#stopTimer = setTimeout(() => {
      this.#teardown(rec, true);
      this.#commitPending();
      this.cb.onState('idle');
    }, 1500);
  }

  #spawn() {
    if (this.track && this.track.readyState !== 'live') {
      this.#fail('track-ended');
      return;
    }
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (this.processLocally && 'processLocally' in rec) rec.processLocally = true;

    rec.onstart = () => {
      this.#startedAt = Date.now();
      this.#lastError = null;
      this.cb.onState('listening');
    };
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res.isFinal) continue;
        const w = words(res[0].transcript);
        const skip = Math.min(this.#forced, w.length);
        this.#forced -= skip;
        const text = w.slice(skip).join(' ');
        if (text) this.cb.onFinal(text, res[0].confidence);
      }
      let interim = '';
      for (const res of e.results) if (!res.isFinal) interim += ` ${res[0].transcript}`;
      const iw = words(interim);
      if (this.#forced > iw.length) this.#forced = iw.length; // recognizer revised the stream
      this.#setPending(iw.slice(this.#forced).join(' '));
    };
    rec.onerror = (e) => {
      this.#lastError = e.error;
      if (FATAL.has(e.error) || (e.error === 'aborted' && this.#active)) {
        this.#fail(e.error, e.message);
      } else if (e.error !== 'no-speech') {
        this.cb.onError(e.error, describeSpeechError(e.error), false);
      }
    };
    rec.onend = () => {
      this.#teardown(rec, false);
      this.#commitPending();
      this.#forced = 0;
      if (!this.#active) {
        this.cb.onState('idle');
        return;
      }
      const lived = Date.now() - this.#startedAt;
      this.#quickEnds = lived < 2000 ? this.#quickEnds + 1 : 0;
      if (this.#quickEnds > 5) {
        this.#fail(this.#lastError || 'restart-loop');
        return;
      }
      const delay = this.#quickEnds ? Math.min(250 * 2 ** this.#quickEnds, 5000) : 0;
      this.cb.onState('restarting');
      this.#restartTimer = setTimeout(() => this.#active && this.#spawn(), delay);
    };

    this.#rec = rec;
    try {
      if (this.track) rec.start(this.track);
      else rec.start();
    } catch (err) {
      this.#teardown(rec, true);
      this.#fail('start-failed', err.message);
    }
  }

  #setPending(text) {
    if (text === this.#pending) return;
    this.#pending = text;
    this.cb.onInterim(text);
    clearTimeout(this.#pauseTimer);
    if (!text) return;
    if (words(text).length >= MAX_INTERIM_WORDS) this.#commitPending();
    else this.#pauseTimer = setTimeout(() => this.#commitPending(), PAUSE_COMMIT_MS);
  }

  #commitPending() {
    clearTimeout(this.#pauseTimer);
    const text = this.#pending;
    if (!text) return;
    this.#pending = '';
    this.#forced += words(text).length;
    this.cb.onInterim('');
    this.cb.onFinal(text, null);
  }

  #teardown(rec, abort) {
    clearTimeout(this.#stopTimer);
    clearTimeout(this.#pauseTimer);
    rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
    if (abort) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    if (this.#rec === rec) this.#rec = null;
  }

  #fail(code, detail) {
    const wasActive = this.#active || !!this.#rec;
    this.#active = false;
    clearTimeout(this.#restartTimer);
    if (this.#rec) this.#teardown(this.#rec, true);
    this.#pending = '';
    this.cb.onError(code, describeSpeechError(code, detail), true);
    if (wasActive || code === 'unsupported') this.cb.onState('idle');
  }
}

// On-device recognition (newer Chrome). Returns 'available' | 'downloadable' |
// 'downloading' | 'unavailable' | 'unsupported'.
export async function onDeviceAvailability(lang) {
  if (!SR) return 'unsupported';
  try {
    if (typeof SR.available === 'function') return await SR.available({ langs: [lang], processLocally: true });
    if (typeof SR.availableOnDevice === 'function') return await SR.availableOnDevice(lang);
  } catch {
    return 'unsupported';
  }
  return 'unsupported';
}

export async function installOnDevice(lang) {
  if (!SR) return false;
  if (typeof SR.install === 'function') return SR.install({ langs: [lang], processLocally: true });
  if (typeof SR.installOnDevice === 'function') return SR.installOnDevice(lang);
  return false;
}

// Chrome cuts off long utterances, so speak in sentence-sized pieces.
function splitForSpeech(text, max = 180) {
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur);
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export const tts = {
  get supported() {
    return 'speechSynthesis' in globalThis;
  },
  get speaking() {
    return this.supported && (speechSynthesis.speaking || speechSynthesis.pending);
  },
  voices() {
    if (!this.supported) return Promise.resolve([]);
    const list = speechSynthesis.getVoices();
    if (list.length) return Promise.resolve(list);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(speechSynthesis.getVoices());
      };
      const timer = setTimeout(done, 1500);
      speechSynthesis.addEventListener('voiceschanged', done);
    });
  },
  async findVoice(locale) {
    const voices = await this.voices();
    const want = String(locale).toLowerCase();
    const norm = normalizeLang(locale);
    const tag = (v) => v.lang.replace('_', '-').toLowerCase();
    return (
      voices.find((v) => tag(v) === want && v.localService) ||
      voices.find((v) => tag(v) === want) ||
      voices.find((v) => normalizeLang(v.lang) === norm) ||
      voices.find((v) => baseOf(v.lang) === baseOf(locale)) ||
      null
    );
  },
  async speak(text, locale, { rate = 1, onStart, onEnd } = {}) {
    if (!this.supported || !text) return { voice: null, spoken: false };
    this.cancel();
    const voice = await this.findVoice(locale);
    const chunks = splitForSpeech(text);
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = voice?.lang || locale;
      if (voice) u.voice = voice;
      u.rate = rate;
      if (i === 0 && onStart) u.onstart = onStart;
      if (i === chunks.length - 1 && onEnd) u.onend = u.onerror = onEnd;
      speechSynthesis.speak(u);
    });
    return { voice, spoken: true };
  },
  cancel() {
    if (this.supported) speechSynthesis.cancel();
  },
};
