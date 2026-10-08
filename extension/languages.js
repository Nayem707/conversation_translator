// Language catalogue shared by recognition (BCP-47 locale), translation and TTS.
export const LANGUAGES = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'es-ES', name: 'Spanish (Spain)' },
  { code: 'es-MX', name: 'Spanish (Mexico)' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
  { code: 'it-IT', name: 'Italian' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  { code: 'nl-NL', name: 'Dutch' },
  { code: 'sv-SE', name: 'Swedish' },
  { code: 'da-DK', name: 'Danish' },
  { code: 'nb-NO', name: 'Norwegian' },
  { code: 'fi-FI', name: 'Finnish' },
  { code: 'pl-PL', name: 'Polish' },
  { code: 'cs-CZ', name: 'Czech' },
  { code: 'ro-RO', name: 'Romanian' },
  { code: 'hu-HU', name: 'Hungarian' },
  { code: 'el-GR', name: 'Greek' },
  { code: 'ru-RU', name: 'Russian' },
  { code: 'uk-UA', name: 'Ukrainian' },
  { code: 'tr-TR', name: 'Turkish' },
  { code: 'ar-SA', name: 'Arabic' },
  { code: 'he-IL', name: 'Hebrew' },
  { code: 'fa-IR', name: 'Persian' },
  { code: 'ur-PK', name: 'Urdu' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'bn-BD', name: 'Bengali (Bangladesh)' },
  { code: 'bn-IN', name: 'Bengali (India)' },
  { code: 'pa-IN', name: 'Punjabi' },
  { code: 'gu-IN', name: 'Gujarati' },
  { code: 'mr-IN', name: 'Marathi' },
  { code: 'ta-IN', name: 'Tamil' },
  { code: 'te-IN', name: 'Telugu' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ja-JP', name: 'Japanese' },
  { code: 'ko-KR', name: 'Korean' },
  { code: 'vi-VN', name: 'Vietnamese' },
  { code: 'th-TH', name: 'Thai' },
  { code: 'id-ID', name: 'Indonesian' },
  { code: 'ms-MY', name: 'Malay' },
  { code: 'fil-PH', name: 'Filipino' },
  { code: 'sw-KE', name: 'Swahili' },
];

const ALIASES = { iw: 'he', tl: 'fil', no: 'nb', jw: 'jv', in: 'id', ji: 'yi' };

export function baseOf(code) {
  return String(code || '').split(/[-_]/)[0].toLowerCase();
}

// Canonical form: base language, except Chinese which keeps the script/region.
export function normalizeLang(code) {
  const raw = String(code || '').replace('_', '-').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'zt' || lower === 'zh-hant' || lower === 'zh-tw' || lower === 'zh-hk') return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh-CN';
  const base = baseOf(lower);
  return ALIASES[base] || base;
}

export function sameLanguage(a, b) {
  const na = normalizeLang(a);
  const nb = normalizeLang(b);
  return !!na && na === nb;
}

const displayNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
})();

export function languageName(code) {
  const known = LANGUAGES.find((l) => l.code === code);
  if (known) return known.name;
  try { return displayNames?.of(normalizeLang(code)) || code; } catch { return code; }
}

// Pick the catalogue locale that best matches an arbitrary language code.
export function bestMatch(code, fallback = 'en-US') {
  if (!code) return fallback;
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === String(code).toLowerCase());
  if (exact) return exact.code;
  const norm = normalizeLang(code);
  const byNorm = LANGUAGES.find((l) => normalizeLang(l.code) === norm);
  return byNorm ? byNorm.code : fallback;
}
