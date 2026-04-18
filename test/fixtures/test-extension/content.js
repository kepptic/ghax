// Content script for the ghax test extension.
//
// Injects a small banner into the page so a human can eyeball whether the
// content script is running (and, after hot-reload, whether the NEW script
// is running — the banner's textContent reads the manifest version which
// the extension dev can bump between reloads to verify).

(function () {
  const version = chrome.runtime.getManifest().version;
  const existing = document.getElementById('ghax-test-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'ghax-test-banner';
  banner.textContent = `ghax test extension v${version} — content script OK`;
  document.documentElement.appendChild(banner);

  console.log(`[ghax-test-ext] content script v${version} injected`);
})();
