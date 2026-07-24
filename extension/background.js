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
const NAVIGATION_TIMEOUT_MS = 8000;
// Chrome clamps repeating alarms to a 30s (0.5 min) floor, so a single alarm
// leaves a worst-case ~30s wake gap after the daemon restarts and the socket
// closes. TWO alarms phase-offset by 15s halve that to ~15s — the cheap half
// of the keepalive story (no offscreen document, per plan §3.7). Both fire the
// same handler; whichever lands first reconnects, the other no-ops.
const KEEPALIVE_ALARM_A = 'ghax-bridge-keepalive';   // unchanged name: survives upgrade
const KEEPALIVE_ALARM_B = 'ghax-bridge-keepalive-b';
const KEEPALIVE_ALARMS = new Set([KEEPALIVE_ALARM_A, KEEPALIVE_ALARM_B]);
const KEEPALIVE_PERIOD_MIN = 0.5;

let ws = null;
// Socket generation — bumped on every connect(). Every socket's event
// listeners capture their generation and act ONLY if they're still current.
// This is what stops a superseded socket's late `close` from scheduling a
// reconnect (or a stale `open` from re-pinging) after a newer socket has
// already taken over. See docs/design/plan/08-bridge-reliability.md §1b.
let socketGen = 0;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let pingTimer = null;
let controlledTabId = null;
let attached = false;
let reattachTimer = null;
let navigationInProgress = false;

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
  // Treat CLOSING as occupied, not free. A socket the daemon just evicted sits
  // in CLOSING until its close event fires; the OLD guard (OPEN/CONNECTING
  // only) let connect() open a SECOND socket in that window while the daemon
  // still held the first — which the daemon logs as "connection replaced" and
  // which self-sustains churn with no rival present. Wait for `close`; its
  // handler schedules the reconnect. See plan §1b.
  if (ws && (ws.readyState === WebSocket.OPEN
          || ws.readyState === WebSocket.CONNECTING
          || ws.readyState === WebSocket.CLOSING)) return;
  const port = await getPort();
  const gen = ++socketGen;
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener('open', async () => {
    if (gen !== socketGen) return; // superseded before we even opened
    reconnectDelay = RECONNECT_BASE_MS;
    // A respawned worker persisted its controlled tab — re-attach proactively
    // so control survives eviction even if the daemon doesn't re-assert.
    await loadPersistedTab();
    let retainedControl = false;
    if (controlledTabId != null) {
      try {
        await attachTo(controlledTabId);
        retainedControl = true;
      } catch (err) {
        if (isTemporarilyUnattachable(err)) {
          // Keep the desired tab through cert/chrome-error interstitials.
          retainedControl = true;
          scheduleReattach();
        } else {
          await persistTab(null); // tab is gone or another debugger owns it
        }
      }
    }
    send({
      type: 'hello',
      agent: 'ghax-ext',
      version: chrome.runtime.getManifest().version,
      controlledTabId: retainedControl ? controlledTabId : null,
    });
    startPing();
    setStatus();
  });

  socket.addEventListener('message', (ev) => {
    if (gen !== socketGen) return; // a newer socket owns the bridge now
    void handleMessage(String(ev.data));
  });

  socket.addEventListener('close', () => {
    // Only the current generation may clear `ws`, stop pinging, or schedule a
    // reconnect. A superseded socket closing is a no-op — otherwise its late
    // close would race a healthy newer socket back into the reconnect loop.
    if (gen !== socketGen) return;
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

function isTemporarilyUnattachable(err) {
  return /cannot attach to this target|cannot (?:access|attach to) (?:a )?(?:chrome|edge):\/\/|no tab with given id|target closed/i.test(err?.message ?? String(err));
}

function cancelReattach() {
  if (!reattachTimer) return;
  clearTimeout(reattachTimer);
  reattachTimer = null;
}

function scheduleReattach(delay = 250) {
  if (reattachTimer || controlledTabId == null || attached || navigationInProgress) return;
  reattachTimer = setTimeout(async () => {
    reattachTimer = null;
    if (controlledTabId == null || attached) return;
    try {
      await attachTo(controlledTabId);
      await setStatus();
      reportControlled();
    } catch (err) {
      if (isTemporarilyUnattachable(err)) scheduleReattach(Math.min(delay * 2, 4000));
      else await setStatus({ detachedReason: err?.message ?? String(err) });
    }
  }, delay);
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
  try {
    await ensureAttached();
  } catch (err) {
    // Certificate interstitials and chrome-error:// pages temporarily refuse
    // chrome.debugger.attach. Keep the tab selected and retry as it returns
    // to an attachable page instead of losing control entirely.
    if (!isTemporarilyUnattachable(err)) throw err;
    attached = false;
    scheduleReattach();
  }
  await setStatus();
  reportControlled();
}

async function stopControl() {
  cancelReattach();
  if (controlledTabId != null) {
    await chrome.debugger.detach({ tabId: controlledTabId }).catch(() => undefined);
  }
  attached = false;
  await persistTab(null);
  await setStatus();
  reportControlled();
}

function watchTabLoad(tabId, timeoutMs) {
  let settled = false;
  let timer;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (tab) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    resolvePromise(tab);
  };
  const onUpdated = (updatedTabId, changeInfo, tab) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') finish(tab);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  timer = setTimeout(() => {
    void chrome.tabs.get(tabId).then(finish, () => finish(null));
  }, timeoutMs);
  return { promise, cancel: () => finish(null) };
}

async function navigateControlledTab(params) {
  const url = params?.url;
  if (typeof url !== 'string') throw new Error('Page.navigate requires a URL');
  if (controlledTabId == null) {
    throw new Error('no tab under control — click "Control this tab" in the ghax bridge popup, or run `ghax bridge control --active`');
  }

  const tabId = controlledTabId;
  const requestedTimeout = Number(params.ghaxLoadTimeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout >= 0
    ? Math.min(requestedTimeout, 30000)
    : NAVIGATION_TIMEOUT_MS;
  const { ghaxLoadTimeoutMs: _ghaxLoadTimeoutMs, ...navigateParams } = params;
  const load = watchTabLoad(tabId, timeoutMs);
  let result = {};
  let tab = null;
  let needsReattach = false;

  navigationInProgress = true;
  cancelReattach();
  try {
    let useTabsUpdate = false;
    try {
      await ensureAttached();
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    } catch (err) {
      if (!isTemporarilyUnattachable(err)) throw err;
      attached = false;
      useTabsUpdate = true;
    }

    if (!useTabsUpdate) {
      try {
        result = await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', navigateParams);
      } catch {
        // Page.navigate may commit a cert-error navigation and then lose its
        // debugger session before replying. Reissuing the same URL through
        // chrome.tabs is safe and does not require an attachable target.
        attached = false;
        useTabsUpdate = true;
      }
    }

    if (useTabsUpdate) await chrome.tabs.update(tabId, { url });
    tab = await load.promise;

    if (!attached) {
      try {
        await attachTo(tabId);
      } catch (err) {
        if (!isTemporarilyUnattachable(err)) throw err;
        // The requested destination may itself be a cert interstitial. Keep
        // control selected so the next goto can escape via chrome.tabs.update.
        needsReattach = true;
      }
    }
  } catch (err) {
    load.cancel();
    throw err;
  } finally {
    navigationInProgress = false;
    if (needsReattach) scheduleReattach();
  }

  await setStatus();
  return {
    ...(result ?? {}),
    ghaxFinalUrl: tab?.url ?? url,
    ghaxTitle: tab?.title ?? '',
  };
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
    let result;
    if (msg.method === 'Page.navigate') {
      result = await navigateControlledTab(msg.params ?? {});
    } else {
      await ensureAttached();
      result = await chrome.debugger.sendCommand({ tabId: controlledTabId }, msg.method, msg.params ?? {});
    }
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
    if (msg.action === 'list-tabs') {
      const tabs = await chrome.tabs.query({});
      send({
        type: 'control-ack', id, ok: true, tabId: controlledTabId,
        result: tabs.filter((tab) => typeof tab.id === 'number').map((tab) => ({
          id: tab.id,
          title: tab.title ?? '',
          url: tab.url ?? '',
          active: tab.id === controlledTabId,
        })),
      });
      return;
    }
    if (msg.action === 'new-window') {
      const win = await chrome.windows.create({ url: msg.url || 'about:blank', focused: false });
      const candidates = win.tabs?.length ? win.tabs : await chrome.tabs.query({ windowId: win.id });
      let tab = candidates.find((candidate) => typeof candidate.id === 'number');
      if (!tab?.id) throw new Error('new window did not create a controllable tab');
      await switchControlTo(tab.id);
      const deadline = Date.now() + 5000;
      while (tab.status !== 'complete' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        tab = await chrome.tabs.get(tab.id);
      }
      send({
        type: 'control-ack', id, ok: true, tabId: tab.id,
        result: { id: tab.id, title: tab.title ?? '', url: tab.url ?? msg.url ?? 'about:blank', active: true },
      });
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
      if (!msg.quiet) {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true });
      }
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
  if (reason === 'target_closed') scheduleReattach();
});

// A cert interstitial temporarily turns the controlled target into an
// unattachable chrome-error:// page. Any subsequent navigation/update is a
// chance to recover, including the user clicking through the interstitial.
chrome.tabs.onUpdated.addListener((tabId) => {
  if (tabId === controlledTabId && !attached) scheduleReattach();
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
  if (!KEEPALIVE_ALARMS.has(alarm.name)) return;
  // Reconnect only when the socket is truly gone. A CLOSING socket is handled
  // by its own close listener (which schedules the reconnect); poking connect()
  // here would be a no-op anyway given the CLOSING guard, but not calling it
  // keeps the intent — and the ownership — in one place.
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    void connect();
  }
});

function ensureAlarm() {
  // create() with the same name replaces any existing schedule — idempotent.
  // Alarm B is phase-offset by ~15s so the two together fire every ~15s.
  chrome.alarms.create(KEEPALIVE_ALARM_A, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  chrome.alarms.create(KEEPALIVE_ALARM_B, {
    delayInMinutes: 0.25,
    periodInMinutes: KEEPALIVE_PERIOD_MIN,
  });
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
