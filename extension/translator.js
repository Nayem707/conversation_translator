// Translation layer. Providers are plain objects implementing
//   translate({ text, source, target, signal, config }) -> { text, detectedSource }
// where `source` is a provider-specific code or 'auto'. Add a provider with
// registerProvider() to swap the backend without touching the UI.
import { normalizeLang, sameLanguage } from './languages.js';

export class TranslationError extends Error {
  constructor(message, { provider, status } = {}) {
    super(message);
    this.name = 'TranslationError';
    this.provider = provider;
    this.status = status;
  }
}

const CODE_MAP = {
  google: { he: 'iw', fil: 'tl', nb: 'no', jv: 'jw' },
  mymemory: { fil: 'tl', nb: 'no' },
  libre: { 'zh-CN': 'zh', 'zh-TW': 'zt', fil: 'tl' },
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

async function fetchJson(url, init, providerId) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new TranslationError(`Network error contacting ${providerId}.`, { provider: providerId });
  }
  if (!res.ok) {
    const hint = res.status === 429 ? ' (rate limited, try again later)' : '';
    throw new TranslationError(`${providerId} responded with HTTP ${res.status}${hint}.`, {
      provider: providerId,
      status: res.status,
    });
  }
  return res.json();
}

const providers = new Map();

export function registerProvider(provider) {
  providers.set(provider.id, provider);
}

registerProvider({
  id: 'google',
  label: 'Google Translate (free web endpoint)',
  host: 'https://translate.googleapis.com/*',
  supportsAuto: true,
  maxChars: 1800,
  async translate({ text, source, target, signal }) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: text });
    const data = await fetchJson(url, { signal }, 'Google Translate');
    if (!Array.isArray(data?.[0])) throw new TranslationError('Unexpected Google Translate response.');
    return {
      text: data[0].map((seg) => seg?.[0] ?? '').join(''),
      detectedSource: typeof data[2] === 'string' ? data[2] : null,
    };
  },
});

registerProvider({
  id: 'mymemory',
  label: 'MyMemory (free, daily quota)',
  host: 'https://api.mymemory.translated.net/*',
  supportsAuto: true,
  preferHint: true, // its auto-detection is weaker than the recognizer's known language
  maxChars: 450,
  async translate({ text, source, target, signal, config }) {
    const url = new URL('https://api.mymemory.translated.net/get');
    const params = { q: text, langpair: `${source === 'auto' ? 'autodetect' : source}|${target}` };
    if (config?.mymemoryEmail) params.de = config.mymemoryEmail;
    url.search = new URLSearchParams(params);
    const data = await fetchJson(url, { signal }, 'MyMemory');
    if (Number(data?.responseStatus) !== 200 || !data?.responseData) {
      throw new TranslationError(`MyMemory: ${data?.responseDetails || 'translation failed'}`, {
        provider: 'mymemory',
      });
    }
    return { text: data.responseData.translatedText, detectedSource: data.responseData.detectedLanguage || null };
  },
});

registerProvider({
  id: 'libre',
  label: 'LibreTranslate (your server URL)',
  host: null,
  supportsAuto: true,
  maxChars: 2000,
  async translate({ text, source, target, signal, config }) {
    const base = (config?.libreUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new TranslationError('LibreTranslate server URL is not configured (Settings).');
    const body = { q: text, source, target, format: 'text' };
    if (config?.libreKey) body.api_key = config.libreKey;
    const data = await fetchJson(
      `${base}/translate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
      'LibreTranslate',
    );
    if (data?.error) throw new TranslationError(`LibreTranslate: ${data.error}`, { provider: 'libre' });
    return { text: data.translatedText ?? '', detectedSource: data.detectedLanguage?.language ?? null };
  },
});

export function listProviders() {
  return [...providers.values()].map(({ id, label, supportsAuto }) => ({ id, label, supportsAuto }));
}

const cache = new Map();
const CACHE_MAX = 300;

async function runProvider(provider, text, { source, sourceHint, target, signal, config }) {
  const wantsAuto = !source || source === 'auto';
  const useAuto = wantsAuto && provider.supportsAuto && !(provider.preferHint && sourceHint);
  const src = providerCode(useAuto ? 'auto' : wantsAuto ? sourceHint : source, provider.id);
  if (src === 'auto' && !provider.supportsAuto) {
    throw new TranslationError(`${provider.label} needs a known source language.`, { provider: provider.id });
  }
  const tgt = providerCode(target, provider.id);
  const key = `${provider.id}|${src}|${tgt}|${text}`;
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
    provider: provider.id,
    providerLabel: provider.label,
  };
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return result;
}

/**
 * Translate `text` into `target`.
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.target        target language (any BCP-47-ish code)
 * @param {string} [opts.source]      source language or 'auto'
 * @param {string} [opts.sourceHint]  used when the provider cannot auto-detect
 * @param {string} [opts.provider]    preferred provider id
 * @param {boolean} [opts.fallback]   try the other providers if the preferred one fails
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.config]      provider settings (libreUrl, libreKey, mymemoryEmail)
 */
export async function translate(text, opts) {
  const clean = String(text || '').trim();
  if (!clean) return { text: '', detectedSource: null, provider: null };
  const known = opts.source && opts.source !== 'auto' ? opts.source : null;
  if (known && sameLanguage(known, opts.target)) {
    return { text: clean, detectedSource: normalizeLang(known), provider: 'none', providerLabel: 'Same language' };
  }

  const order = [opts.provider || 'google'];
  if (opts.fallback) for (const id of providers.keys()) if (!order.includes(id)) order.push(id);

  const errors = [];
  for (const id of order) {
    const provider = providers.get(id);
    if (!provider) continue;
    if (id === 'libre' && !opts.config?.libreUrl) {
      if (id === order[0]) errors.push('LibreTranslate server URL is not configured (Settings).');
      continue;
    }
    try {
      return await runProvider(provider, clean, opts);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      errors.push(err.message);
    }
  }
  throw new TranslationError(errors.join(' ') || 'No translation provider available.');
}
