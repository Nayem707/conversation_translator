// End-to-end smoke test: loads the unpacked extension into the installed Chrome
// and exercises the panel, captions, microphone, tab audio, TTS and a normal page.
// Run: node run.mjs        (HEADFUL=1 node run.mjs to watch)
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '..', '..', 'extension');
const FIX = join(here, 'fixtures');
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

const W = 1400;
const H = 900;
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 10000, step = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: !process.env.HEADFUL,
  pipe: true,
  enableExtensions: true,
  protocolTimeout: 30000,
  defaultViewport: { width: W, height: H },
  // Keep the network-backed speech service and TTS voices available.
  ignoreDefaultArgs: ['--disable-background-networking', '--disable-component-extensions-with-background-pages'],
  // No --use-fake-ui-for-media-stream: it breaks chromeMediaSource:'tab' capture (NotFoundError).
  args: [`--window-size=${W},${H + 120}`, '--autoplay-policy=no-user-gesture-required'],
});
const info = [];
const note = (name, detail) => {
  info.push({ name, detail });
  console.log(`INFO  ${name}  -- ${detail}`);
};

const extId = await browser.installExtension(EXT);
const ext = (await browser.extensions()).get(extId);
record('extension loaded', !!ext, extId);
await sleep(1000);
const welcome = (await browser.pages()).find((p) => p.url().includes('welcome.html'));
record('welcome/permissions page opened on install', !!welcome);
await welcome?.close();
for (const origin of ['https://meet.google.com', `chrome-extension://${extId}`]) {
  await browser.defaultBrowserContext().overridePermissions(origin, ['microphone']).catch((e) => note('permission override', `${origin}: ${e.message}`));
}

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));

await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (url.startsWith('https://meet.google.com/__fixtures/')) {
    return req.respond({ status: 200, contentType: 'audio/wav', body: readFileSync(join(FIX, url.split('/').pop())) });
  }
  if (url.startsWith('https://meet.google.com/')) {
    return req.respond({ status: 200, contentType: 'text/html', body: readFileSync(join(FIX, 'meet.html')) });
  }
  return req.continue();
});

// ---------------------------------------------------------------- meeting page
await page.goto('https://meet.google.com/abc-defg-hij', { waitUntil: 'load' });
const hasHost = await waitFor(() => page.evaluate(() => !!document.querySelector('live-translator-host')), 5000);
record('content script auto-injected on meet.google.com', !!hasHost);

const sidebarFrame = () => page.frames().find((f) => f.url().includes('/sidebar.html'));
await page.mouse.click(W - 20 - 24, H - 96 - 24); // floating button
const firstFrame = await waitFor(async () => {
  const f = sidebarFrame();
  return f && (await f.$('#srcLang option')) ? f : null;
}, 8000);
record('floating button opens sidebar iframe', !!firstFrame);
// Always talk to the live frame object.
const frame = new Proxy({}, { get: (_, prop) => { const f = sidebarFrame(); const v = f[prop]; return typeof v === 'function' ? v.bind(f) : v; } });
if (!firstFrame) {
  await page.screenshot({ path: join(OUT, 'failure.png') });
  await browser.close();
  process.exit(1);
}
await sleep(500);
await page.screenshot({ path: join(OUT, '1-panel-open.png') });

// Puppeteer's frame.click() hangs on scroll-into-view inside out-of-process
// extension iframes, so dispatch DOM clicks instead.
const clickIn = (sel) => frame.$eval(sel, (el) => el.click());
const panelBox = async () => {
  const b = await (await frame.frameElement()).boundingBox();
  return b && `${Math.round(b.x)},${Math.round(b.y)}`;
};
const B = '.speaker[data-speaker="B"]';
const A = '.speaker[data-speaker="A"]';
const text = (sel) => frame.$eval(sel, (el) => el.textContent.trim()).catch(() => '');
const logEntries = () =>
  frame.$$eval('#log li', (lis) =>
    lis.map((li) => ({
      speaker: li.dataset.speaker,
      head: li.querySelector('.entry-head')?.textContent.trim(),
      orig: li.querySelector('.orig')?.textContent.trim(),
      trans: li.querySelector('.trans')?.textContent.trim(),
      err: li.querySelector('.err')?.textContent.trim(),
    })),
  );

const initialPanel = await panelBox();
await frame.select('#srcLang', 'en-US');
await frame.select('#tgtLang', 'es-ES');

// ------------------------------------------------------------- captions source
await frame.select(`${B} [data-role="input"]`, 'captions');
await clickIn(`${B} [data-action="start"]`);
const reading = await waitFor(async () => ((await text(`${B} [data-role="state"]`)) === 'Reading captions' ? true : null), 5000);
record('captions reader attaches to Meet caption region', !!reading, await text(`${B} [data-role="state"]`));
const captionRun = page.evaluate(() =>
  window.runCaptions([
    { name: 'Maria', text: 'Hola, ¿cómo estás? Me gustaría programar una reunión para mañana por la mañana.' },
    { name: 'You', text: 'I am doing well, thank you very much.' },
  ]),
);
await sleep(1200);
const interimSeen = await text(`${B} [data-role="original"] .interim`);
record('caption interim text shown live', interimSeen.length > 0, interimSeen);
await captionRun;
const capEntries = await waitFor(async () => {
  const l = await logEntries();
  return l.length >= 2 && l.every((e) => e.trans && e.trans !== 'Translating…') ? l : null;
}, 15000);
const maria = capEntries?.find((e) => e.head?.includes('Maria'));
const you = capEntries?.find((e) => e.head?.includes('You'));
record('caption (Spanish) translated to English for Speaker B', !!maria?.trans && /meeting|tomorrow/i.test(maria.trans), JSON.stringify(maria));
record('own "You" caption routed to Speaker A and translated to Spanish', you?.speaker === 'A' && !!you?.trans, JSON.stringify(you));
note('translation provider used from the extension', await text(`${B} [data-role="translatedTo"]`));
record('detected language shown', /Spanish|English/.test(await text(`${B} [data-role="detected"]`)), await text(`${B} [data-role="detected"]`));
await page.screenshot({ path: join(OUT, '2-captions-translated.png') });
await clickIn(`${B} [data-action="stop"]`);

// ----------------------------------------------------------- microphone source
const before = (await logEntries()).length;
await clickIn(`${A} [data-action="start"]`);
const micIndicator = await waitFor(async () => ((await text('#indicators')).includes('Microphone active') ? true : null), 5000);
record('microphone active indicator shown', !!micIndicator, await text('#indicators'));
// Automation cannot inject speech into Chrome's recognizer microphone path, so
// this only reports what the real default microphone produced.
await sleep(6000);
const micEntry = (await logEntries()).slice(before).find((x) => x.speaker === 'A');
note(
  'microphone session (real default mic, room audio)',
  micEntry ? JSON.stringify(micEntry) : `state=${await text(`${A} [data-role="state"]`)} notice=${await text(`${A} [data-role="notice"]`) || 'none'}`,
);
await page.screenshot({ path: join(OUT, '3-microphone.png') });
await clickIn(`${A} [data-action="stop"]`).catch(() => {});
await sleep(800);
const micStopped = (await text('#indicators')) === '';
record('stopping clears the capture indicator', micStopped, await text('#indicators'));

// ------------------------------------------------------------ text-to-speech
const voices = await frame.evaluate(
  () =>
    new Promise((resolve) => {
      if (speechSynthesis.getVoices().length) return resolve(speechSynthesis.getVoices().length);
      speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices().length), { once: true });
      setTimeout(() => resolve(speechSynthesis.getVoices().length), 3000);
    }),
);
record('speechSynthesis voices available', voices > 0, `${voices} voices`);
await clickIn(`${A} [data-action="speak"]`);
await sleep(400);
const speaking = await frame.evaluate(() => speechSynthesis.speaking || speechSynthesis.pending);
record('Speak Translation starts speechSynthesis', speaking);
await frame.evaluate(() => speechSynthesis.cancel());

// ------------------------------------------------------------- tab audio source
await clickIn('#swapBtn'); // Speaker B now speaks English
await frame.select(`${B} [data-role="input"]`, 'tab');
await clickIn(`${B} [data-action="start"]`);
const notInvoked = await waitFor(async () => ((await text(`${B} [data-role="notice"]`)).includes('toolbar icon') ? true : null), 6000);
record('tab capture refused before toolbar invocation (Chrome rule), with guidance', !!notInvoked, await text(`${B} [data-role="notice"]`));
await ext.triggerAction(page); // equivalent to clicking the toolbar icon on this tab
await sleep(800);
record('toolbar invocation acknowledged in sidebar', (await text(`${B} [data-role="notice"]`)).includes('authorized'), await text(`${B} [data-role="notice"]`));
await page.evaluate(() => document.getElementById('participant').play());
const beforeTab = (await logEntries()).length;
await clickIn(`${B} [data-action="start"]`);
const tabActive = await waitFor(async () => ((await text('#indicators')).includes('Tab audio') ? true : null), 8000);
record('tab audio captured (indicator shown)', !!tabActive, `${await text('#indicators')} | notice=${await text(`${B} [data-role="notice"]`)}`);
const tabEntry = await waitFor(async () => {
  const l = await logEntries();
  return l.slice(beforeTab).find((x) => x.speaker === 'B' && x.trans && x.trans !== 'Translating…') || null;
}, 35000, 500);
record('tab audio transcribed + translated', !!tabEntry, tabEntry ? JSON.stringify(tabEntry) : `state=${await text(`${B} [data-role="state"]`)} notice=${await text(`${B} [data-role="notice"]`)}`);
await page.screenshot({ path: join(OUT, '4-tab-audio.png') });
await clickIn(`${B} [data-action="stop"]`).catch(() => {});
await sleep(1000);
const offscreenGone = await waitFor(async () => {
  const t = browser.targets().filter((x) => x.url().includes('offscreen.html'));
  return t.length === 0 ? true : null;
}, 5000);
record('offscreen audio worker closed after stop', !!offscreenGone);

// --------------------------------------------------------- drag / minimize / UI
record('panel stayed in place during all interactions', (await panelBox()) === initialPanel, `${initialPanel} -> ${await panelBox()}`);
await page.mouse.move(1100, 30);
await page.mouse.down();
await page.mouse.move(900, 80, { steps: 8 });
await page.mouse.move(700, 120, { steps: 8 });
await page.mouse.up();
await sleep(300);
const box = await (await frame.frameElement()).boundingBox();
record('panel draggable by its header', box && box.x < 800, box ? `iframe x=${Math.round(box.x)} y=${Math.round(box.y)}` : '');
await page.screenshot({ path: join(OUT, '5-dragged.png') });
await sleep(300);
await page.mouse.click(W - 20 - 24, H - 96 - 24); // floating button toggles minimize
await sleep(500);
const minimizedBox = await (await frame.frameElement()).boundingBox();
record('floating button minimizes panel (iframe kept alive)', !minimizedBox || minimizedBox.height < 2, JSON.stringify(minimizedBox));
await page.screenshot({ path: join(OUT, '6-minimized.png') });
await page.mouse.click(W - 20 - 24, H - 96 - 24);
await sleep(300);

// ------------------------------------------------------------ normal web page
const page2 = await browser.newPage();
await page2.goto('https://example.com', { waitUntil: 'load' });
const noAutoInject = !(await page2.evaluate(() => !!document.querySelector('live-translator-host')));
record('no injection on normal pages without user action (minimal permissions)', noAutoInject);
await ext.triggerAction(page2);
const frame2 = await waitFor(async () => {
  const f = page2.frames().find((x) => x.url().includes('/sidebar.html'));
  return f && (await f.$('#srcLang option')) ? f : null;
}, 8000);
record('toolbar icon opens translator on a normal page (activeTab + scripting)', !!frame2);
if (frame2) {
  const caps = await frame2.$$eval('#caps li', (lis) => lis.map((li) => li.textContent.trim()));
  console.log('\nCapability panel on example.com:\n  ' + caps.join('\n  '));
  await page2.screenshot({ path: join(OUT, '7-normal-page.png') });
}

const relevantErrors = consoleErrors.filter((e) => !/favicon|ERR_BLOCKED/i.test(e));
record('no console errors on meeting page', relevantErrors.length === 0, relevantErrors.slice(0, 5).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
