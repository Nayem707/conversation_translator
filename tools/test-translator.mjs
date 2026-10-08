// Live check of the translation providers. Run: node tools/test-translator.mjs
import { translate, listProviders } from '../extension/translator.js';

const cases = [
  { text: 'Hello, how are you today?', target: 'es-ES', sourceHint: 'en-US' },
  { text: '¿Puedes oírme bien?', target: 'en-US', sourceHint: 'es-ES' },
  { text: 'আপনি কেমন আছেন?', target: 'en-US', sourceHint: 'bn-BD' },
  { text: 'שלום', target: 'fil-PH', sourceHint: 'he-IL' },
];

let failed = 0;
for (const p of listProviders().filter((p) => p.id !== 'libre')) {
  for (const c of cases) {
    try {
      const r = await translate(c.text, { source: 'auto', sourceHint: c.sourceHint, target: c.target, provider: p.id });
      console.log(`[${p.id}] ${c.text} -> (${c.target}) ${r.text}  detected=${r.detectedSource}`);
    } catch (err) {
      // The free Google endpoint rate-limits bursts from time to time.
      if (p.id === 'google' && err.status === 429) {
        console.log(`[${p.id}] SKIPPED ${c.text}: HTTP 429 (temporarily rate limited)`);
        continue;
      }
      failed++;
      console.log(`[${p.id}] FAILED ${c.text}: ${err.message}`);
    }
  }
}

const same = await translate('Hello', { source: 'en-GB', target: 'en-US', provider: 'google' });
console.log(`same-language passthrough: ${same.provider === 'none' ? 'ok' : 'FAILED'}`);

try {
  await translate('Hello', { source: 'auto', target: 'fr', provider: 'libre', fallback: false, config: {} });
  console.log('libre unconfigured: FAILED (no error)');
  failed++;
} catch (err) {
  console.log(`libre unconfigured error: ${err.message}`);
}

const fb = await translate('Good morning', { source: 'auto', target: 'de', provider: 'libre', fallback: true, config: {} });
console.log(`fallback from unconfigured libre -> ${fb.provider}: ${fb.text}`);

const long = 'This is a sentence. '.repeat(40);
const lr = await translate(long, { source: 'en', target: 'fr', provider: 'mymemory' });
console.log(`mymemory chunked long text: ${lr.text.length} chars`);

process.exit(failed ? 1 : 0);
