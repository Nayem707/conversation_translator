// Audio capture helpers. Three distinct sources, each with its own browser rules:
//   microphone    -> handled by SpeechRecognition itself (speech.js)
//   tab audio     -> chrome.tabCapture stream id (service worker) consumed in the
//                    offscreen document (see offscreen.js)
//   screen/system -> getDisplayMedia() share picker, user must tick "Share audio"
import { isSpeechRecognitionSupported, supportsTrackRecognition } from './speech.js';

export class AudioCapture {
  #stream;
  #ctx;
  #analyser;
  #buf;
  #meterTimer = 0;

  /**
   * @param {MediaStream} stream
   * @param {{ playback?: boolean }} opts  playback re-routes captured audio to the
   *   speakers. Required for tab capture, because Chrome mutes a captured tab.
   */
  constructor(stream, { playback = false } = {}) {
    this.#stream = stream;
    this.#ctx = new AudioContext();
    const src = this.#ctx.createMediaStreamSource(stream);
    this.#analyser = this.#ctx.createAnalyser();
    this.#analyser.fftSize = 512;
    this.#buf = new Float32Array(this.#analyser.fftSize);
    src.connect(this.#analyser);
    if (playback) src.connect(this.#ctx.destination);
  }

  get track() {
    return this.#stream.getAudioTracks()[0] || null;
  }

  onEnded(cb) {
    this.track?.addEventListener('ended', cb, { once: true });
  }

  startMeter(cb, intervalMs = 250) {
    this.stopMeter();
    this.#meterTimer = setInterval(() => {
      this.#analyser.getFloatTimeDomainData(this.#buf);
      let sum = 0;
      for (const s of this.#buf) sum += s * s;
      cb(Math.min(1, Math.sqrt(sum / this.#buf.length) * 5));
    }, intervalMs);
  }

  stopMeter() {
    clearInterval(this.#meterTimer);
    this.#meterTimer = 0;
  }

  stop() {
    this.stopMeter();
    this.#stream.getTracks().forEach((t) => t.stop());
    this.#ctx.close().catch(() => {});
  }
}

export async function captureTabStream(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  return new AudioCapture(stream, { playback: true });
}

// Must be called from a user gesture. The picker is the consent prompt.
export async function captureDisplayAudio() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen/system audio capture is not available in this context. Try the pop-out window.');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
  });
  const audioTracks = stream.getAudioTracks();
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!audioTracks.length) {
    throw new Error(
      'No audio was shared. In the picker choose a tab and enable "Share tab audio", or (Windows/ChromeOS) choose "Entire screen" and enable "Share system audio".',
    );
  }
  return new AudioCapture(new MediaStream(audioTracks));
}

export async function detectCapabilities() {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let micPermission = 'unknown';
  try {
    micPermission = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    /* not queryable here */
  }
  return {
    speechRecognition: isSpeechRecognitionSupported(),
    trackRecognition: supportsTrackRecognition(),
    displayCapture: !!navigator.mediaDevices?.getDisplayMedia,
    systemAudioOS: /Windows|CrOS/.test(navigator.userAgent),
    onDeviceApi: !!SR && (typeof SR.available === 'function' || typeof SR.availableOnDevice === 'function'),
    tts: 'speechSynthesis' in globalThis,
    micPermission,
  };
}
