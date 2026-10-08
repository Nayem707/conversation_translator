# Live Conversation Translator (Chrome extension, Manifest V3)

A floating, draggable translator panel for Google Meet, Microsoft Teams, Zoom Web and any other page.
Pure JavaScript/HTML/CSS. No frameworks, no AI/LLM services.

- **Speech → text:** Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`)
- **Language detection:** Chrome's built-in language detector (`chrome.i18n.detectLanguage`, runs locally), with the translation provider's detected source and a Unicode-script heuristic as fallbacks
- **Translation:** Google Translate free web endpoint, MyMemory, or your own LibreTranslate server (modular, see `translator.js`)
- **Text → speech:** `speechSynthesis` with installed voices

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. A welcome page opens. Click **Allow microphone** once (see "Microphone permission" below).

## Use

- On Meet / Teams / Zoom Web a round button appears bottom-right (drag it anywhere). Click it to open the panel.
- On any other page click the toolbar icon or press **Alt+Shift+T**. Optionally enable "floating button on every website" on the welcome page.
- The panel header drags the panel; **–** minimizes (listening continues), **✕** closes (stops everything), **⧉** pops it out into its own window. The panel corner is resizable.
- **Source language** = Speaker A (you). **Target language** = Speaker B (the other person). A's speech is translated into B's language and vice versa.
- Speaker B's **Input** can be:
  - **Microphone (take turns):** both people share your mic; press Start on whoever is speaking.
  - **Tab audio (meeting participants):** transcribes what the meeting tab plays. Requires clicking the toolbar icon on that tab first (Chrome rule).
  - **Screen / system audio:** share picker; tick "Share tab audio" or (Windows/ChromeOS) "Share system audio".
  - **Meeting captions:** reads the captions Meet / Teams / Zoom Web display (turn captions on in the meeting).
- **🔊 Speak Translation** reads the last translation aloud; **Auto-speak** does it automatically.
- **Save history** (off by default) persists the transcript in `chrome.storage.local`; turning it off deletes it.

## What the browser actually allows (analysis)

| Question | Answer |
|---|---|
| Can microphone speech be captured? | **Yes.** `SpeechRecognition` in an extension page. Chrome shows its microphone prompt on first use. If a site blocks the prompt for embedded frames, grant access on the welcome page or use the pop-out window. |
| Can Meet/Teams/Zoom participant audio be captured? | **Only as tab audio**, i.e. the mixed audio the browser tab plays. There is no API for another application's internal per-participant streams. |
| Can tab audio be captured? | **Yes**, via `chrome.tabCapture.getMediaStreamId` in the service worker, but **only after the user invokes the extension on that tab** (toolbar click or shortcut). The stream is consumed in an offscreen document. Transcribing it uses `SpeechRecognition.start(audioTrack)`, which needs **Chrome 135+**. |
| Which parts need explicit permission? | Microphone (browser prompt), tab capture (toolbar invocation per tab), screen/system audio (share picker every time), all-sites floating button (optional host permission), LibreTranslate server (optional host permission for that origin). |
| What is impossible with content scripts alone? | Content scripts cannot capture any audio, cannot call `tabCapture`, and cannot hear desktop applications. They can only read page DOM, which is how the captions reader works. Zoom/Teams **desktop apps** are reachable only through Windows/ChromeOS "Share system audio". |

Implementation consequences:

- Chrome **mutes a captured tab**, so the offscreen document replays the captured audio. Recognition runs there too, outside the captured tab. Replaying from the in-page panel would loop the replay back into the capture.
- `SpeechRecognition` needs the spoken language up front; it does not auto-detect. Detection therefore runs on the recognised text. If it disagrees with the selected language, the panel offers to switch the language or reassign the utterance to the other speaker.
- In continuous mode Chrome can keep one interim result growing without ever finalizing it. `speech.js` commits text after a 1.2 s pause or 40 words. It tracks committed words so Chrome's later finals don't duplicate them.

## Architecture

```
extension/
├── manifest.json     MV3; storage, activeTab, scripting, tabCapture, offscreen
├── background.js     toolbar action, tabCapture stream ids, offscreen lifecycle, badge, all-sites script
├── content.js        floating button + draggable/minimizable panel (closed shadow DOM) + captions reader
├── sidebar.html/css  panel UI (iframe from the extension origin, isolated from page CSS/JS)
├── sidebar.js        UI controller: speakers, detection, translation, history, settings
├── speech.js         SpeechSession (continuous STT with restart + segmentation), tts, on-device helpers
├── translator.js     provider registry: google, mymemory, libre (+ registerProvider for new ones)
├── audio.js          AudioCapture (playback, level meter), tab stream, getDisplayMedia, capability probe
├── offscreen.html/js tab-audio capture + playback + recognition, results broadcast by runtime messages
├── languages.js      language list, code normalisation, display names
├── welcome.html/js   permissions & help (also the options page)
└── icons/
```

Adding a translation backend:

```js
import { registerProvider } from './translator.js';
registerProvider({
  id: 'myapi', label: 'My API', supportsAuto: true, maxChars: 1000,
  async translate({ text, source, target, signal, config }) { /* fetch… */ return { text, detectedSource: null }; },
});
```

Add its host to `host_permissions` (or request it at runtime) so the extension page can call it.

## Permissions and privacy

| Permission | Why |
|---|---|
| `storage` | Settings, panel position, optional history |
| `activeTab` + `scripting` | Inject the panel on the current tab when you click the toolbar icon |
| `tabCapture` | Tab-audio source (still gated by the per-tab toolbar invocation) |
| `offscreen` | Hidden document that consumes and replays the tab stream |
| Hosts: `translate.googleapis.com`, `api.mymemory.translated.net` | Translation requests |
| Content script on Meet / Teams / Zoom Web | Floating button and captions reader there |
| Optional `https://*/*`, `http://*/*` | Only if you enable the button on all sites, or for a LibreTranslate origin |

- Audio is never recorded or stored. Chrome's recognizer sends audio to Google's speech service unless on-device recognition is available and enabled (Settings).
- Recognised text goes to the selected translation provider.
- Capture is always visible: red "LIVE" badge in the panel header, red dot on the floating button, "ON" toolbar badge, and pills such as "Microphone active · Speaker A".
- Closing the panel, reloading the page or closing the pop-out window stops every recognizer and capture. The offscreen worker also watches a port held by the panel.

## Platform notes and limitations

- **Google Meet:** captions reader targets Meet's caption region (`role="region"` labelled Captions, plus known class names). Meet labels your own captions "You"; those are shown under Speaker A. Meet changes obfuscated class names, so the reader falls back to the region's text when specific selectors miss.
- **Microsoft Teams (web):** captions via `data-tid="closed-caption-*"` / `author` attributes. Tab audio works in the browser client only.
- **Zoom Web (`*.zoom.us/wc/…`):** captions via `live-transcription-subtitle` classes, including inside Zoom's same-origin iframe. Zoom captions/transcription must be enabled by the host.
- **Desktop apps:** not reachable except via Windows/ChromeOS "Share system audio" (macOS/Linux can share tab audio only).
- **Fullscreen:** elements outside the page's fullscreen element are hidden by the browser; use the pop-out window during fullscreen.
- **Echo:** with speakers instead of headphones, the microphone hears translated speech. "Ignore microphone while reading a translation aloud" (default on) drops recognition results during TTS.
- **One recognizer per microphone:** Speakers A and B cannot both listen to the mic at once (turn-taking). Mic + tab audio can run together.
- **Free endpoints:** Google's free web endpoint is unofficial and can rate-limit. MyMemory has a daily quota (add an email in Settings to raise it). Use your own LibreTranslate for reliability.
- **TTS voices** depend on the OS; if no voice exists for the language the panel says so and the browser falls back to a default voice.

## Testing

```
node tools/make-icons.mjs          # regenerate icons
node tools/test-translator.mjs     # live provider checks from Node
cd tools/e2e && npm install && HEADFUL=1 node run.mjs   # (PowerShell: $env:HEADFUL=1; node run.mjs)
```

`tools/e2e/run.mjs` loads the unpacked extension into the installed Chrome via Puppeteer. A fake meeting page is served at a real `https://meet.google.com/...` URL through request interception. The run checks:

- auto-injection, the floating button, and opening the panel
- caption reading, live interim text, language detection, and translation (Spanish → English, own captions → Speaker A)
- the microphone session indicator and Stop
- TTS voices and Speak Translation
- tab capture refused before toolbar invocation (with guidance), then authorized via a real toolbar action
- tab audio captured, transcribed with `SpeechRecognition.start(track)`, segmented, and translated
- offscreen cleanup after Stop
- panel drag, minimize/restore without reloading, and toolbar-only injection on a normal page (example.com)

Last run on Chrome 155 / Windows: **24/24 checks passed**.

Not verifiable by automation, so check these manually:

- **Microphone transcription:** Chrome's recognizer ignores the fake-microphone file, but the same recognizer path is verified through the track input.
- **Real logged-in Meet, Teams and Zoom meetings:** their live caption DOM may differ from the fixture.
- **The `getDisplayMedia` share picker.**
#   c o n v e r s a t i o n _ t r a n s l a t o r  
 