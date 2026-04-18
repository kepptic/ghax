# ghax test extension

A minimal MV3 extension for exercising `ghax ext hot-reload` without
touching any of your real extensions.

## What it does

- Service worker (`background.js`) logs its version on startup.
- Content script (`content.js`) injects a black banner reading
  `ghax test extension v<version> — content script OK` at the top of
  every page on `example.com` or `example.org`.
- CSS (`content.css`) styles the banner.

## How to test `ghax ext hot-reload`

1. Load this directory as an unpacked extension in Edge (or Chrome):
   - Open `edge://extensions` (or `chrome://extensions`).
   - Enable **Developer mode**.
   - Click **Load unpacked** → pick this directory.
   - Note the assigned extension ID.

2. Open `https://example.com` in a tab. You should see a green-on-black
   banner at the top reading the current version.

3. Attach ghax and confirm it sees the extension:

   ```bash
   ./dist/ghax attach
   ./dist/ghax ext list --json | grep -A2 '"ghax test extension"' || true
   ./dist/ghax ext sw <ext-id> eval "chrome.runtime.getManifest().version"
   ```

4. Bump `"version"` in `manifest.json` (e.g. `0.0.1` → `0.0.2`) and bump
   the same string in `content.js` too (since we hard-code it at inject
   time). Save.

5. Run hot-reload:

   ```bash
   ./dist/ghax ext hot-reload <ext-id> --verbose
   ```

   Expected: `re-injected into 1 of 1 tabs, SW version=0.0.1 → 0.0.2,
   <N>ms`. The banner on the open example.com tab should update to
   `v0.0.2` **without you refreshing the tab**.

6. Verify the SW is the new one:

   ```bash
   ./dist/ghax ext sw <ext-id> eval "chrome.runtime.getManifest().version"
   # → "0.0.2"
   ```

## Cleanup

Remove the extension via `edge://extensions` → toggle off or uninstall.
The fixture files here are harmless to leave in place.
