/**
 * ghax bridge — popup UI. Plain JS, no build step, no dependencies.
 * Talks to background.js exclusively via chrome.runtime.sendMessage, except
 * for the label/port fields, which are plain chrome.storage.local values the
 * worker reads on its next connect.
 */

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const roleNote = document.getElementById('roleNote');
const tabInfo = document.getElementById('tabInfo');
const errEl = document.getElementById('err');
const labelInput = document.getElementById('labelInput');
const portInput = document.getElementById('portInput');
const savedEl = document.getElementById('saved');

/**
 * Build a note from alternating text / <code> parts. Deliberately DOM
 * construction rather than innerHTML: `dormantReason` is daemon-supplied and
 * this popup runs with extension privileges, so no interpolated string ever
 * gets parsed as markup.
 */
function setNote(el, parts) {
  el.textContent = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      el.appendChild(document.createTextNode(part));
    } else {
      const code = document.createElement('code');
      code.textContent = part.code;
      el.appendChild(code);
    }
  }
}

function render(status) {
  const connected = !!status?.connected;
  const role = status?.role ?? null;
  const parked = role === 'parked';
  dot.classList.toggle('on', connected && !parked);
  dot.classList.toggle('parked', connected && parked);

  const controlling = status?.controlledTabId != null && status?.attached;
  if (status?.dormantReason) {
    statusText.textContent = 'not accepted by the daemon';
  } else if (!connected) {
    statusText.textContent = 'waiting for daemon…';
  } else if (parked) {
    statusText.textContent = 'connected — parked';
  } else if (controlling) {
    statusText.textContent = 'connected — controlling a tab';
  } else if (status?.controlledTabId != null) {
    statusText.textContent = 'connected — attaching…';
  } else {
    statusText.textContent = 'connected — no tab selected';
  }

  // Say WHY, and what to do about it. A parked browser with no explanation
  // looks broken — which is exactly the confusion this model exists to remove.
  if (status?.dormantReason) {
    setNote(roleNote, [
      `The daemon rejected this browser: ${status.dormantReason}. Retrying in a few minutes.`,
    ]);
  } else if (parked) {
    setNote(roleNote, [
      'Another browser is bound to this ghax daemon, so this one sits idle ' +
      '(no debugger attached, nothing to clean up). Switch to it with ',
      { code: 'ghax bridge use' },
      ', or list them with ',
      { code: 'ghax bridge instances' },
      '.',
    ]);
  } else {
    roleNote.textContent = '';
  }

  tabInfo.textContent = status?.controlledTabId != null ? `tab id: ${status.controlledTabId}` : '';
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'status' });
    render(res);
  } catch {
    render({ connected: false });
  }
}

document.getElementById('controlBtn').addEventListener('click', async () => {
  errEl.textContent = '';
  const res = await chrome.runtime.sendMessage({ action: 'control-tab' });
  if (!res?.ok) errEl.textContent = res?.error ?? 'failed to control this tab';
  refresh();
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  errEl.textContent = '';
  await chrome.runtime.sendMessage({ action: 'stop' });
  refresh();
});

// ─── Label + port ────────────────────────────────────────────
// Both apply on the next connect. The label also rides in `hello`, so
// `ghax bridge instances` can show a human name instead of a UUID prefix.
// The port field is the escape hatch for running a second daemon against a
// second browser (GHAX_STATE_FILE + --bridge-port on the daemon side).
async function loadSettings() {
  const { ghaxLabel, bridgePort } = await chrome.storage.local.get(['ghaxLabel', 'bridgePort']);
  if (typeof ghaxLabel === 'string') labelInput.value = ghaxLabel;
  if (Number.isFinite(Number(bridgePort)) && Number(bridgePort) > 0) portInput.value = String(bridgePort);
}

let savedTimer = null;
function flashSaved(msg) {
  savedEl.textContent = msg;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { savedEl.textContent = ''; }, 2000);
}

labelInput.addEventListener('change', async () => {
  await chrome.storage.local.set({ ghaxLabel: labelInput.value.trim() });
  flashSaved('label saved — reconnect to apply');
});

portInput.addEventListener('change', async () => {
  const port = Number(portInput.value);
  if (!Number.isFinite(port) || port <= 0) {
    await chrome.storage.local.remove('bridgePort');
    flashSaved('port cleared (default 9223)');
    return;
  }
  await chrome.storage.local.set({ bridgePort: port });
  flashSaved('port saved — reconnect to apply');
});

loadSettings();
refresh();
setInterval(refresh, 1000);
