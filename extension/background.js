/**
 * ghax bridge — background service worker.
 *
 * Relays CDP commands between the ghax daemon (over a localhost WebSocket,
 * see src/bridge.ts) and a single "controlled" tab (via chrome.debugger,
 * which — unlike --remote-debugging-port — is not blocked on Edge 150+ /
 * Chrome 136+'s default profile).
 *
 * Wire format (see src/bridge.ts for the daemon side):
 *   -> daemon, on connect:   {"type":"hello","agent":"ghax-ext","version":"...","controlledTabId":N|null}
 *   <- daemon, a CDP cmd:    {"id":<n>,"method":"Page.navigate","params":{...}}
 *   -> daemon, its reply:    {"id":<n>,"result":{...}} | {"id":<n>,"error":{"message":"..."}}
 *   -> daemon, a CDP event:  {"type":"event","method":"...","params":{...}}
 *   <> keepalive:            -> {"type":"ping"}   <- {"type":"pong"} (both ignored)
 *   <- daemon, control:      {"type":"control","id":<n>,"action":"control-active"|"control-tab"|"stop","tabId?":N}
 *   -> daemon, control ack:  {"type":"control-ack","id":<n>,"ok":bool,"tabId?":N,"error?":"..."}
 *   -> daemon, control note: {"type":"controlled","tabId":N|null}   (pushed on any change)
 *
 * MV3 service workers are EPHEMERAL — Chrome evicts them after ~30s idle.
 * Two mechanisms keep this bridge alive and self-healing:
 *   1. A `chrome.alarms` alarm (needs the "alarms" permission) — alarms
 *      WAKE an evicted SW; a bare setInterval dies with the worker. The
 *      handler reconnects if the socket is gone.
 *   2. An application-level `{type:"ping"}` every ~15s while connected —
 *      active WS traffic extends the SW's lifetime between evictions.
 * Control target (`controlledTabId`) is persisted in chrome.storage.local
 * so a respawned worker knows which tab it was driving; on reconnect it
 * re-attaches proactively (and the daemon also re-asserts — see gap 3 in
 * src/bridge.ts). onStartup/onInstalled also kick a connect.
 */

const DEFAULT_PORT = 9223;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const PING_INTERVAL_MS = 15000;
const KEEPALIVE_ALARM = 'ghax-bridge-keepalive';
// Chrome clamps repeating alarms to a 30s (0.5 min) floor. 0.5 is the
// smallest value that fires without a warning and reliably resurrects an
// evicted worker — worst-case reconnect is one alarm period (~30s).
const KEEPALIVE_PERIOD_MIN = 0.5;

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let pingTimer = null;
let controlledTabId = null;
let attached = false;

async function getPort() {
  const { bridgePort } = await chrome.storage.local.get('bridgePort');
  const port = Number(bridgePort);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

async function setStatus(extra = {}) {
  // Polled by the popup rather than pushed — the popup may open well after
  // a status change happens, and MV3 has no persistent connection to a
  // closed popup to push to anyway.
  await chrome.storage.local.set({
    bridgeStatus: {
      connected: ws?.readyState === WebSocket.OPEN,
      controlledTabId,
      attached,
      ...extra,
    },
  });
}

async function loadPersistedTab() {
  const { controlledTabId: saved } = await chrome.storage.local.get('controlledTabId');
  if (typeof saved === 'number') controlledTabId = saved;
}

async function persistTab(tabId) {
  controlledTabId = tabId;
  if (tabId == null) {
    await chrome.storage.local.remove('controlledTabId');
  } else {
    await chrome.storage.local.set({ controlledTabId: tabId });
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Push the current controlled tab to the daemon so /bridge-status can
// report it and gap-3 re-assert logic can reason about it.
function reportControlled() {
  send({ type: 'controlled', tabId: controlledTabId });
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'ping' });
    else stopPing();
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const port = await getPort();
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener('open', async () => {
    reconnectDelay = RECONNECT_BASE_MS;
    // A respawned worker persisted its controlled tab — re-attach proactively
    // so control survives eviction even if the daemon doesn't re-assert.
    await loadPersistedTab();
    let reattached = false;
    if (controlledTabId != null) {
      try {
        await attachTo(controlledTabId);
        reattached = true;
      } catch {
        await persistTab(null); // tab is gone; forget it
      }
    }
    send({
      type: 'hello',
      agent: 'ghax-ext',
      version: chrome.runtime.getManifest().version,
      controlledTabId: reattached ? controlledTabId : null,
    });
    startPing();
    setStatus();
  });

  socket.addEventListener('message', (ev) => {
    void handleMessage(String(ev.data));
  });

  socket.addEventListener('close', () => {
    if (ws === socket) ws = null;
    stopPing();
    setStatus();
    scheduleReconnect();
  });

  // 'close' always fires after 'error' for the WHATWG WebSocket — no
  // separate handling needed here beyond not crashing the worker.
  socket.addEventListener('error', () => undefined);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    void connect();
  }, reconnectDelay);
}

// Attach chrome.debugger to `tabId`, tolerating "already attached" (which
// happens if the previous SW instance left the session live).
async function attachTo(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (!/already attached/i.test(msg)) throw err;
  }
  attached = true;
}

async function ensureAttached() {
  if (attached) return;
  if (controlledTabId == null) {
    throw new Error('no tab under control — click "Control this tab" in the ghax bridge popup, or run `ghax bridge control --active`');
  }
  await attachTo(controlledTabId);
}

// The single code path both the popup and the daemon control channel use to
// point the bridge at a tab: detach any prior tab, persist the new one,
// attach, and tell the daemon.
async function switchControlTo(tabId) {
  if (attached && controlledTabId != null && controlledTabId !== tabId) {
    await chrome.debugger.detach({ tabId: controlledTabId }).catch(() => undefined);
    attached = false;
  }
  await persistTab(tabId);
  await ensureAttached();
  await setStatus();
  reportControlled();
}

async function stopControl() {
  if (controlledTabId != null) {
    await chrome.debugger.detach({ tabId: controlledTabId }).catch(() => undefined);
  }
  attached = false;
  await persistTab(null);
  await setStatus();
  reportControlled();
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Keepalive frames carry no work.
  if (msg.type === 'ping' || msg.type === 'pong') return;

  // Daemon → extension control channel (scriptable activation, no popup).
  if (msg.type === 'control') {
    await handleControl(msg);
    return;
  }

  // Everything else is a CDP command to relay: {id, method, params}.
  if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  try {
    await ensureAttached();
    const result = await chrome.debugger.sendCommand({ tabId: controlledTabId }, msg.method, msg.params ?? {});
    send({ id: msg.id, result: result ?? {} });
  } catch (err) {
    send({ id: msg.id, error: { message: err?.message ?? String(err) } });
  }
}

async function handleControl(msg) {
  const id = msg.id ?? null;
  try {
    if (msg.action === 'stop') {
      await stopControl();
      send({ type: 'control-ack', id, ok: true, tabId: null });
      return;
    }
    let tabId;
    if (msg.action === 'control-active') {
      // A service worker has no "current window" — currentWindow can return
      // nothing from here. lastFocusedWindow is the reliable query.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab in the last-focused window');
      tabId = tab.id;
    } else if (msg.action === 'control-tab') {
      if (typeof msg.tabId !== 'number') throw new Error('control-tab requires a numeric tabId');
      tabId = msg.tabId;
    } else {
      throw new Error(`unknown control action: ${msg.action}`);
    }
    await switchControlTo(tabId);
    send({ type: 'control-ack', id, ok: true, tabId });
  } catch (err) {
    send({ type: 'control-ack', id, ok: false, error: err?.message ?? String(err) });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== controlledTabId) return;
  send({ type: 'event', method, params });
});

// Fires when the user clicks Chrome's "Cancel" on the debugging banner, the
// tab crashes, devtools is opened on the same tab (steals the debugger
// session), or we call chrome.debugger.detach() ourselves.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== controlledTabId) return;
  attached = false;
  void setStatus({ detachedReason: reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === controlledTabId) {
    attached = false;
    void persistTab(null).then(() => {
      reportControlled();
      return setStatus();
    });
  }
});

// Keepalive alarm — resurrects an evicted SW and reconnects if the socket
// is gone. Registered at top level so it re-arms on every SW spawn.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    void connect();
  }
});

function ensureAlarm() {
  // create() with the same name replaces any existing schedule — idempotent.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
}

// Messages from popup.js.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.action === 'control-tab') {
      // The popup runs in a real window context, so currentWindow is valid
      // here (unlike from the SW's control-active path).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'no active tab found' });
        return;
      }
      try {
        await switchControlTo(tab.id);
        sendResponse({ ok: true, tabId: tab.id, title: tab.title, url: tab.url });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
      return;
    }

    if (message?.action === 'stop') {
      await stopControl();
      sendResponse({ ok: true });
      return;
    }

    if (message?.action === 'status') {
      sendResponse({
        ok: true,
        connected: ws?.readyState === WebSocket.OPEN,
        controlledTabId,
        attached,
      });
      return;
    }

    sendResponse({ ok: false, error: `unknown action: ${message?.action}` });
  })();
  return true; // keep the message channel open for the async sendResponse above
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void init();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void init();
});

async function init() {
  await loadPersistedTab();
  await connect();
}

ensureAlarm();
void init();
