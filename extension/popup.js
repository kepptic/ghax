/**
 * ghax bridge — popup UI. Plain JS, no build step, no dependencies.
 * Talks to background.js exclusively via chrome.runtime.sendMessage.
 */

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const tabInfo = document.getElementById('tabInfo');
const errEl = document.getElementById('err');

function render(status) {
  const connected = !!status?.connected;
  dot.classList.toggle('on', connected);
  const controlling = status?.controlledTabId != null && status?.attached;
  if (!connected) {
    statusText.textContent = 'waiting for daemon…';
  } else if (controlling) {
    statusText.textContent = 'connected — controlling a tab';
  } else if (status?.controlledTabId != null) {
    statusText.textContent = 'connected — attaching…';
  } else {
    statusText.textContent = 'connected — no tab selected';
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

refresh();
setInterval(refresh, 1000);
