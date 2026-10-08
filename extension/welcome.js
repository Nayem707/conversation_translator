const ALL_SITES = ['https://*/*', 'http://*/*'];
const $ = (id) => document.getElementById(id);

function setStatus(el, text, cls = '') {
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function refreshMic() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    const text = { granted: 'Granted', denied: 'Blocked. Allow it from the site settings (lock icon).', prompt: 'Not granted yet' }[p.state];
    setStatus($('micStatus'), text, p.state === 'granted' ? 'ok' : p.state === 'denied' ? 'err' : '');
    p.onchange = refreshMic;
  } catch {
    setStatus($('micStatus'), '');
  }
}

$('micBtn').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // only needed for the permission grant
    setStatus($('micStatus'), 'Granted. You can close this tab and use the translator.', 'ok');
  } catch (err) {
    setStatus($('micStatus'), `Not granted: ${err.message}`, 'err');
  }
});

async function refreshAllSites() {
  $('allSites').checked = await chrome.permissions.contains({ origins: ALL_SITES });
}

$('allSites').addEventListener('change', async (e) => {
  try {
    const ok = e.target.checked
      ? await chrome.permissions.request({ origins: ALL_SITES })
      : await chrome.permissions.remove({ origins: ALL_SITES });
    setStatus(
      $('allSitesStatus'),
      ok ? (e.target.checked ? 'Enabled. Reload open tabs to see the button.' : 'Disabled.') : 'Not changed.',
      ok ? 'ok' : '',
    );
  } catch (err) {
    setStatus($('allSitesStatus'), err.message, 'err');
  }
  refreshAllSites();
});

chrome.commands.getAll().then((cmds) => {
  const shortcut = cmds.find((c) => c.name === '_execute_action')?.shortcut;
  $('shortcut').textContent = shortcut || 'not set (chrome://extensions/shortcuts)';
});

refreshMic();
refreshAllSites();
