// Translation layer. Free, key-less web translation endpoints only: no AI/LLM
// services, no paid APIs, no backend. All provider-specific code lives here;
// the UI only calls configureTranslator(), translateText() and listProviders().
//
// A provider function receives provider-specific language codes and returns
// { text, detectedSource } or throws a TranslationError. translateText() tries
// the selected provider first, then the others in FALLBACK_ORDER.
import { normalizeLang, sameLanguage } from './languages.js';

export const ALL_FAILED_MESSAGE =
  'Translation unavailable.\nAll configured translation providers failed.\nPlease check your internet connection or provider settings.';

export class TranslationError extends Error {
  constructor(message, { provider, status, attempts } = {}) {
    super(message);
    this.name = 'TranslationError';
    this.provider = provider;
    this.status = status;
    this.attempts = attempts || [];
  }
}

const CODE_MAP = {
  google: { he: 'iw', fil: 'tl', nb: 'no', jv: 'jw' },
  mymemory: { fil: 'tl', nb: 'no' },
  libretranslate: { 'zh-CN': 'zh', 'zh-TW': 'zt', fil: 'tl' },
};

function providerCode(code, providerId) {
  if (!code || code === 'auto') return 'auto';
  const norm = normalizeLang(code);
  return CODE_MAP[providerId]?.[norm] ?? norm;
}

// Split long text on sentence boundaries so each request stays under `max` chars.
function chunkText(text, max) {
  if (text.length <= max) return [text];
  const parts = text.match(/[^.!?。！？\n]+[.!?。！？\n]*\s*/g) || [text];
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if ((current + part).length > max && current) {
      chunks.push(current);
      current = '';
    }
    if (part.length > max) {
      for (let i = 0; i < part.length; i += max) chunks.push(part.slice(i, i + max));
    } else {
      current += part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function fetchJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new TranslationError('network error', { status: 'network' });
  }
  if (!res.ok) {
    const message = res.status === 429 ? 'rate limited (HTTP 429)' : `HTTP ${res.status}`;
    throw new TranslationError(message, { status: res.status });
  }
  try {
    return await res.json();
  } catch {
    throw new TranslationError('invalid response', { status: 'invalid' });
  }
}

const invalid = (detail = 'invalid response') => new TranslationError(detail, { status: 'invalid' });

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}

// --- Google Translate: free web endpoint (NOT the paid Cloud Translation API) --

async function translateWithGoogle({ text, source, target, signal }) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.search = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: text });
  const data = await fetchJson(url, { signal });
  if (!Array.isArray(data?.[0])) throw invalid();
  const out = data[0].map((seg) => (typeof seg?.[0] === 'string' ? seg[0] : '')).join('');
  if (!out.trim()) throw invalid('empty translation');
  return { text: out, detectedSource: typeof data[2] === 'string' ? data[2] : null };
}

// --- MyMemory: free, anonymous daily quota; optional email raises it --------

// MyMemory reports some failures as "translations" with HTTP 200.
const MYMEMORY_NOTICE = /^(MYMEMORY WARNING|PLEASE SELECT|INVALID (SOURCE|TARGET) LANGUAGE|NO QUERY SPECIFIED|QUERY LENGTH LIMIT)/i;
const comparable = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Its best answer can be a fuzzy translation-memory hit for a *different*
// sentence (e.g. "thank you for your help" for "thank you for your help
// today"), which is often wrong. Accept exact memory hits and machine
// translations ("MT!") only.
function pickMyMemory(data, query) {
  const top = data.responseData;
  if (Number(top.match) >= 1) return top.translatedText;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const mt = matches.find((m) => m['created-by'] === 'MT!' && typeof m.translation === 'string' && m.translation.trim());
  if (mt) return mt.translation;
  const same = matches.find((m) => m.translation === top.translatedText && comparable(m.segment) === comparable(query));
  return same ? top.translatedText : null;
}

async function translateWithMyMemory({ text, source, target, signal, config }) {
  const url = new URL('https://api.mymemory.translated.net/get');
  const params = { q: text, langpair: `${source === 'auto' ? 'autodetect' : source}|${target}` };
  if (config.mymemoryEmail) params.de = config.mymemoryEmail;
  url.search = new URLSearchParams(params);
  const data = await fetchJson(url, { signal });
  const status = Number(data?.responseStatus);
  const top = data?.responseData?.translatedText;
  if (data?.quotaFinished || status === 429 || /^MYMEMORY WARNING/i.test(top || '')) {
    throw new TranslationError('daily free quota used up', { status: 429 });
  }
  if (status !== 200) throw invalid(String(data?.responseDetails || `error ${data?.responseStatus ?? 'response'}`).toLowerCase());
  if (typeof top !== 'string' || !top.trim()) throw invalid('empty translation');
  if (MYMEMORY_NOTICE.test(top)) throw invalid(top.toLowerCase());
  const out = pickMyMemory(data, text);
  if (!out) throw invalid('no reliable translation (only a fuzzy memory match)');
  return { text: decodeEntities(out), detectedSource: data.responseData.detectedLanguage || null };
}

// --- LibreTranslate: only a server URL the user configured ------------------

function libreBase(config) {
  return String(config.libreUrl || '').trim().replace(/\/+$/, '');
}

async function translateWithLibreTranslate({ text, source, target, signal, config }) {
  const base = libreBase(config);
  if (!base) throw new TranslationError('server URL not configured', { status: 'not-configured' });
  const body = { q: text, source, target, format: 'text' };
  if (config.libreKey) body.api_key = config.libreKey;
  const data = await fetchJson(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (data?.error) throw invalid(String(data.error));
  if (typeof data?.translatedText !== 'string' || !data.translatedText.trim()) throw invalid('empty translation');
  return { text: data.translatedText, detectedSource: data.detectedLanguage?.language ?? null };
}

// --- Provider registry -------------------------------------------------------

const providers = {
  google: {
    name: 'Google Translate (free web endpoint)',
    role: 'Default',
    supportsAuto: true,
    maxChars: 1800,
    translate: translateWithGoogle,
  },
  mymemory: {
    name: 'MyMemory',
    role: 'Fallback',
    supportsAuto: true,
    preferHint: true, // its auto-detection is weaker than the recognizer's known language
    maxChars: 450,
    translate: translateWithMyMemory,
  },
  libretranslate: {
    name: 'LibreTranslate',
    role: 'Optional',
    supportsAuto: true,
    maxChars: 2000,
    translate: translateWithLibreTranslate,
    isConfigured: (config) => !!libreBase(config),
  },
};

export const FALLBACK_ORDER = ['google', 'mymemory', 'libretranslate'];

export function registerProvider(id, provider) {
  providers[id] = provider;
  if (!FALLBACK_ORDER.includes(id)) FALLBACK_ORDER.push(id);
}

export function listProviders() {
  return FALLBACK_ORDER.filter((id) => providers[id]).map((id) => ({
    id,
    name: providers[id].name,
    role: providers[id].role || '',
  }));
}

export function providerName(id) {
  return providers[id]?.name || id;
}

// Provider settings. The LibreTranslate API key is kept in chrome.storage.local
// by the UI; extension storage is NOT a secure secret vault (any code running in
// the extension, and anyone with access to the browser profile, can read it), so
// never put sensitive production credentials there.
let settings = { provider: 'google', libreUrl: '', libreKey: '', mymemoryEmail: '' };

export function configureTranslator({ provider, libreUrl, libreKey, mymemoryEmail } = {}) {
  const next = { provider, libreUrl, libreKey, mymemoryEmail };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) settings[k] = v;
}

const cache = new Map();
const CACHE_MAX = 300;

async function runProvider(id, text, { source, sourceHint, target, signal, config }) {
  const provider = providers[id];
  const wantsAuto = !source || source === 'auto';
  const useAuto = wantsAuto && provider.supportsAuto && !(provider.preferHint && sourceHint);
  const src = providerCode(useAuto ? 'auto' : wantsAuto ? sourceHint : source, id);
  if (src === 'auto' && !provider.supportsAuto) throw new TranslationError('needs a known source language');
  const tgt = providerCode(target, id);
  const key = `${id}|${src}|${tgt}|${text}`;
  if (cache.has(key)) return cache.get(key);

  let detectedSource = null;
  const out = [];
  for (const chunk of chunkText(text, provider.maxChars)) {
    const r = await provider.translate({ text: chunk, source: src, target: tgt, signal, config });
    out.push(r.text);
    detectedSource ||= r.detectedSource;
  }
  const result = {
    text: out.join(' ').trim(),
    detectedSource: detectedSource ? normalizeLang(detectedSource) : null,
    provider: id,
    providerName: provider.name,
  };
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return result;
}

/** One line per failed or skipped provider, e.g. "MyMemory: network error". */
export function describeAttempts(attempts = []) {
  return attempts.map((a) => `${a.name}: ${a.error}`).join('\n');
}

/**
 * Translate `text` with the selected provider, falling back through the others.
 * @param {string} text
 * @param {string} sourceLanguage  BCP-47-ish code, or 'auto'
 * @param {string} targetLanguage  BCP-47-ish code
 * @param {object} [options]
 * @param {string} [options.sourceHint]  likely source, for providers that cannot auto-detect well
 * @param {string} [options.provider]    overrides the configured provider
 * @param {boolean} [options.fallback]   false = stop after the first provider that is actually tried
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.config]      overrides configureTranslator() settings
 * @returns {Promise<{text, detectedSource, provider, providerName, attempts}>}
 *   `attempts` lists providers that failed or were skipped before the one that answered.
 * @throws {TranslationError} with ALL_FAILED_MESSAGE and `attempts` when every provider fails
 */
export async function translateText(text, sourceLanguage, targetLanguage, options = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { text: '', detectedSource: null, provider: null, providerName: '', attempts: [] };
  if (!targetLanguage) throw new TranslationError('No target language selected.');
  const known = sourceLanguage && sourceLanguage !== 'auto' ? sourceLanguage : null;
  if (known && sameLanguage(known, targetLanguage)) {
    return {
      text: clean,
      detectedSource: normalizeLang(known),
      provider: 'none',
      providerName: 'No translation needed (same language)',
      attempts: [],
    };
  }

  const config = { ...settings, ...options.config };
  const preferred = options.provider || config.provider || 'google';
  const order = [preferred, ...FALLBACK_ORDER.filter((id) => id !== preferred)];
  const attempts = [];
  let tried = 0;
  for (const id of order) {
    if (options.fallback === false && tried) break;
    const provider = providers[id];
    if (!provider) {
      attempts.push({ provider: id, name: id, error: 'provider unavailable' });
      continue;
    }
    if (provider.isConfigured && !provider.isConfigured(config)) {
      attempts.push({ provider: id, name: provider.name, error: 'server URL not configured', skipped: true });
      continue;
    }
    tried++;
    try {
      const r = await runProvider(id, clean, {
        source: sourceLanguage,
        sourceHint: options.sourceHint,
        target: targetLanguage,
        signal: options.signal,
        config,
      });
      return { ...r, attempts };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      attempts.push({ provider: id, name: provider.name, error: err.message || 'failed', status: err.status });
    }
  }
  throw new TranslationError(ALL_FAILED_MESSAGE, { attempts });
}
