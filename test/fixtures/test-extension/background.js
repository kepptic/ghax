// Minimal service worker for the ghax test extension.
//
// Logs its version on startup and responds to a simple ping message — just
// enough surface to verify that ghax ext hot-reload actually swapped the SW
// (check the version bump) and that the new SW is receiving messages.

const manifest = chrome.runtime.getManifest();
console.log(`[ghax-test-ext] service worker v${manifest.version} booted`);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, version: manifest.version, at: Date.now() });
  }
  return true;
});
