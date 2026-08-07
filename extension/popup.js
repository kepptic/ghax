/**
 * ghax bridge — popup UI. Plain JS, no build step, no dependencies.
 * Talks to background.js exclusively via chrome.runtime.sendMessage, except
 * for the label/port fields, which are plain chrome.storage.local values the
 * worker reads on its next connect.
 *
 * One row per daemon connection (the worker dials a range of ports so several
 * agents can drive the same browser). Rows for ports with no daemon are hidden
 * — an empty list means "nothing is attached", not "ten things are broken".
 */

const list = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const errEl = document.getElementById('err');
const labelInput = document.getElementById('labelInput');
const portInput = document.getElementById('portInput');
const pairInput = document.getElementById('pairInput');
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

/** Build a `.note` div, fill it via setNote, and append it to `row`. */
function appendNote(row, parts) {
  const note = document.createElement('div');
  note.className = 'note';
  setNote(note, parts);
  row.appendChild(note);
}

function statusLine(conn) {
  const parked = conn.role === 'parked';
  if (conn.dormantReason) return 'not accepted by the daemon';
  if (!conn.connected) return 'reconnecting…';
  if (parked) return 'connected — parked';
  if (conn.controlledTabId != null && conn.attached) return 'controlling a tab';
  if (conn.controlledTabId != null) return 'attaching…';
  return 'connected — no tab selected';
}

function renderRow(conn) {
  const row = document.createElement('div');
  row.className = 'conn';

  const head = document.createElement('div');
  head.className = 'row';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const parked = conn.role === 'parked';
  if (conn.connected && !parked && !conn.dormantReason) dot.classList.add('on');
  if (conn.connected && parked) dot.classList.add('parked');
  head.appendChild(dot);

  const port = document.createElement('strong');
  port.textContent = `:${conn.port}`;
  head.appendChild(port);

  const text = document.createElement('span');
  text.textContent = statusLine(conn);
  head.appendChild(text);
  row.appendChild(head);

  // Say WHY, and what to do about it. A parked browser with no explanation
  // looks broken — which is exactly the confusion this model exists to remove.
  if (conn.dormantReason) {
    appendNote(row, [
      `The daemon rejected this browser: ${conn.dormantReason}. Retrying in a few minutes.`,
    ]);
  } else if (parked) {
    appendNote(row, [
      'Another browser is bound to this ghax daemon, so this one sits idle ' +
      '(no debugger attached, nothing to clean up). Switch to it with ',
      { code: 'ghax bridge use' },
      ', or list them with ',
      { code: 'ghax bridge instances' },
      '.',
    ]);
  }

  if (conn.controlledTabId != null) {
    const info = document.createElement('div');
    info.className = 'tabInfo';
    info.textContent = `tab id: ${conn.controlledTabId}`;
    row.appendChild(info);
  }

  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = 'Control this tab';
  control.addEventListener('click', () => act({ action: 'control-tab', port: conn.port }));
  row.appendChild(control);

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => act({ action: 'stop', port: conn.port }));
  row.appendChild(stop);

  return row;
}

function render(status) {
  const all = Array.isArray(status?.connections) ? status.connections : [];
  // A port nobody is listening on is noise: show a connection only once it has
  // reached a daemon, or once it has something to say (a rejection, or a tab
  // it still wants back).
  const live = all.filter((c) => c.connected || c.dormantReason || c.controlledTabId != null);
  list.textContent = '';
  for (const conn of live) list.appendChild(renderRow(conn));
  emptyEl.textContent = live.length
    ? ''
    : `No ghax daemon found on ports ${status?.basePort ?? 9223}–${(status?.basePort ?? 9223) + (status?.portRange ?? 10) - 1}. Run \`ghax attach --extension\`.`;
}

async function act(message) {
  errEl.textContent = '';
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) errEl.textContent = res?.error ?? 'action failed';
  refresh();
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'status' });
    render(res);
  } catch {
    render({ connections: [] });
  }
}

// ─── Label + port ────────────────────────────────────────────
// Both apply on the next connect. The label also rides in `hello`, so
// `ghax bridge instances` can show a human name instead of a UUID prefix.
// The port field sets the BASE of the scanned range — the worker dials
// base..base+9, which is how several daemons (one per agent) are found.
async function loadSettings() {
  const { ghaxLabel, bridgePort, ghaxPairToken } = await chrome.storage.local.get(
    ['ghaxLabel', 'bridgePort', 'ghaxPairToken'],
  );
  if (typeof ghaxLabel === 'string') labelInput.value = ghaxLabel;
  if (Number.isFinite(Number(bridgePort)) && Number(bridgePort) > 0) portInput.value = String(bridgePort);
  if (typeof ghaxPairToken === 'string') pairInput.value = ghaxPairToken;
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
  } else {
    await chrome.storage.local.set({ bridgePort: port });
    flashSaved('base port saved — rescanning');
  }
  chrome.runtime.sendMessage({ action: 'reconnect' }).catch(() => undefined);
});

pairInput.addEventListener('change', async () => {
  const code = pairInput.value.trim();
  if (!code) {
    await chrome.storage.local.remove('ghaxPairToken');
    flashSaved('pairing code cleared');
    return;
  }
  await chrome.storage.local.set({ ghaxPairToken: code });
  // A fresh code likely means we were rejected; nudge a reconnect attempt so
  // the user doesn't wait out the dormant retry window.
  chrome.runtime.sendMessage({ action: 'reconnect' }).catch(() => undefined);
  flashSaved('pairing code saved — reconnecting');
});

loadSettings();
refresh();
setInterval(refresh, 1000);
