// Translation layer tests. Run: node tools/test-translator.mjs
// Live requests go to the real free endpoints; failure scenarios wrap fetch to
// break specific hosts, and LibreTranslate is a local mock server (no public
// LibreTranslate instance is used).
import { createServer } from 'node:http';
import {
  translateText,
  configureTranslator,
  listProviders,
  describeAttempts,
  ALL_FAILED_MESSAGE,
} from '../extension/translator.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const run = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: err };
  }
};

// --- fetch control ----------------------------------------------------------
const realFetch = globalThis.fetch;
let broken = {}; // host -> 'network' | HTTP status | 'json-garbage' | 'quota'
globalThis.fetch = async (url, init) => {
  const host = new URL(url).host;
  const mode = broken[host];
  if (mode === 'network') throw new TypeError('Failed to fetch');
  if (typeof mode === 'number') return new Response('{}', { status: mode });
  if (mode === 'json-garbage') return new Response('<html>oops</html>', { status: 200 });
  if (mode === 'fuzzy') {
    return Response.json({
      responseStatus: 200,
      responseData: { translatedText: "j'espère que ta journée se passe bien", match: 0.86 },
      matches: [{ segment: 'thank you for your help', translation: "j'espère que ta journée se passe bien", 'created-by': 'Public Web', match: 0.86 }],
    });
  }
  if (mode === 'quota') {
    return Response.json({
      responseStatus: 200,
      responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.' },
    });
  }
  return realFetch(url, init);
};
const GOOGLE = 'translate.googleapis.com';
const MYMEMORY = 'api.mymemory.translated.net';

// --- mock LibreTranslate server ------------------------------------------------
let libreMode = 'ok';
let libreLastBody = null;
const libre = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/translate') return res.writeHead(404).end('{}');
    libreLastBody = JSON.parse(raw);
    if (libreMode === 'fail') return res.writeHead(503).end('{"error":"busy"}');
    res.end(JSON.stringify({ translatedText: `libre:${libreLastBody.target}:${libreLastBody.q}` }));
  });
});
await new Promise((r) => libre.listen(0, '127.0.0.1', r));
const LIBRE_URL = `http://127.0.0.1:${libre.address().port}`;

console.log(`Providers: ${listProviders().map((p) => `${p.name} (${p.role})`).join(', ')}\n`);

// --- 1-5: language pairs, live, default provider (Google) ------------------------
configureTranslator({ provider: 'google', libreUrl: '', libreKey: '' });
const BENGALI = /[\u0980-\u09FF]/;
const pairs = [
  { n: 1, name: 'English -> Bangla', text: 'Hello, how are you?', src: 'en', tgt: 'bn', ok: (t) => BENGALI.test(t) },
  { n: 2, name: 'Bangla -> English', text: 'আপনি কেমন আছেন?', src: 'bn', tgt: 'en', ok: (t) => /how are you/i.test(t) },
  { n: 3, name: 'English -> French', text: 'Good morning, see you tomorrow.', src: 'en', tgt: 'fr', ok: (t) => /bonjour|demain/i.test(t) },
  { n: 4, name: 'French -> English', text: 'Merci beaucoup, à demain.', src: 'fr', tgt: 'en', ok: (t) => /thank|tomorrow/i.test(t) },
];
let googleUsed = 0;
for (const p of pairs) {
  const r = await run(() => translateText(p.text, 'auto', p.tgt, { sourceHint: p.src }));
  if (r.provider === 'google') googleUsed++;
  check(
    `${p.n}. ${p.name}`,
    !r.error && p.ok(r.text),
    r.error ? r.error.message : `"${p.text}" -> "${r.text}"  via ${r.providerName}, detected=${r.detectedSource}`,
  );
}
check('5. Google Translate succeeds as the default provider', googleUsed === pairs.length, `${googleUsed}/${pairs.length} answered by Google`);

for (const p of pairs) {
  const r = await run(() => translateText(p.text, 'auto', p.tgt, { sourceHint: p.src, provider: 'mymemory', fallback: false }));
  check(`   MyMemory alone: ${p.name}`, !r.error && p.ok(r.text), r.error ? describeAttempts(r.error.attempts) : `"${r.text}"`);
}

// --- 6: Google failure -> MyMemory ------------------------------------------------
const sentences = { network: 'I will call you back in ten minutes', 429: 'Please send me the slides after the call', 'json-garbage': 'Can everyone see my screen' };
for (const mode of ['network', 429, 'json-garbage']) {
  broken = { [GOOGLE]: mode };
  const r = await run(() => translateText(sentences[mode], 'auto', 'fr', { sourceHint: 'en' }));
  check(
    `6. Google ${mode === 429 ? 'HTTP 429' : mode} -> MyMemory`,
    r.provider === 'mymemory' && !!r.text && r.attempts[0]?.provider === 'google',
    r.error ? r.error.message : `"${r.text}" via ${r.providerName}; ${describeAttempts(r.attempts)}`,
  );
}

broken = { [GOOGLE]: 'network' };
const fuzzyLive = await run(() => translateText('Thank you for your help today', 'auto', 'fr', { sourceHint: 'en' }));
check(
  '   MyMemory never returns a fuzzy memory hit for a different sentence (live)',
  !/journée se passe bien/.test(fuzzyLive.text || ''),
  fuzzyLive.error ? `rejected: ${describeAttempts(fuzzyLive.error.attempts).replace(/\n/g, '; ')}` : `"${fuzzyLive.text}"`,
);

// --- 7: Google + MyMemory failure -> LibreTranslate ---------------------------------
configureTranslator({ libreUrl: LIBRE_URL, libreKey: 'secret-key' });
for (const mm of [500, 'quota', 'fuzzy']) {
  broken = { [GOOGLE]: 'network', [MYMEMORY]: mm };
  libreMode = 'ok';
  const r = await run(() => translateText(`Where is the station (${mm})`, 'auto', 'bn', { sourceHint: 'en-US' }));
  check(
    `7. Google + MyMemory ${typeof mm === 'number' ? `HTTP ${mm}` : mm === 'quota' ? 'quota warning' : 'fuzzy-only answer'} -> LibreTranslate`,
    r.provider === 'libretranslate' && r.text.startsWith('libre:bn:') && r.attempts.length === 2,
    r.error ? describeAttempts(r.error.attempts) : `"${r.text}"; ${describeAttempts(r.attempts).replace(/\n/g, '; ')}`,
  );
}
check(
  '   LibreTranslate request body is { q, source, target, format, api_key }',
  libreLastBody?.format === 'text' && libreLastBody.target === 'bn' && libreLastBody.source === 'auto' && libreLastBody.api_key === 'secret-key',
  JSON.stringify(libreLastBody),
);

// --- 8: every provider fails ---------------------------------------------------------
broken = { [GOOGLE]: 503, [MYMEMORY]: 'network' };
libreMode = 'fail';
const all = await run(() => translateText('This will not translate', 'auto', 'fr', { sourceHint: 'en' }));
check(
  '8. All providers fail -> clear error, nothing returned',
  all.error?.message === ALL_FAILED_MESSAGE && all.error.attempts.length === 3 && all.text === undefined,
  all.error ? `${all.error.message.replace(/\n/g, ' ')} [${describeAttempts(all.error.attempts).replace(/\n/g, '; ')}]` : `returned "${all.text}"`,
);

// --- 9: LibreTranslate selected but not configured ---------------------------------------
broken = {};
configureTranslator({ provider: 'libretranslate', libreUrl: '', libreKey: '' });
const noLibre = await run(() => translateText('Good night', 'auto', 'fr', { sourceHint: 'en' }));
check(
  '9. LibreTranslate selected without a server URL -> skipped, falls back to Google',
  noLibre.provider === 'google' && noLibre.attempts[0]?.provider === 'libretranslate' && /not configured/.test(noLibre.attempts[0]?.error),
  noLibre.error ? noLibre.error.message : `"${noLibre.text}" via ${noLibre.providerName}; ${describeAttempts(noLibre.attempts)}`,
);
broken = { [GOOGLE]: 'network', [MYMEMORY]: 'network' };
const noLibreAll = await run(() => translateText('Good night again', 'auto', 'fr', { sourceHint: 'en' }));
check(
  '   ...and with the others down, the error names the missing configuration',
  noLibreAll.error?.message === ALL_FAILED_MESSAGE && /LibreTranslate: server URL not configured/.test(describeAttempts(noLibreAll.error.attempts)),
  noLibreAll.error ? describeAttempts(noLibreAll.error.attempts).replace(/\n/g, '; ') : `returned "${noLibreAll.text}"`,
);

// --- extras ----------------------------------------------------------------------------
broken = {};
configureTranslator({ provider: 'google' });
const same = await translateText('Hello', 'en-GB', 'en-US');
check('   same language is passed through without a request', same.provider === 'none' && same.text === 'Hello');
const long = await run(() => translateText('This is a sentence. '.repeat(40), 'en', 'fr', { provider: 'mymemory', fallback: false }));
check('   MyMemory splits long text into chunks', !long.error && long.text.length > 400, long.error ? long.error.message : `${long.text.length} chars`);

libre.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll translation checks passed');
process.exit(failed ? 1 : 0);
