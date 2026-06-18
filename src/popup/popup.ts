/**
 * Popup Script — simplified status display only
 */

let showLogs = false;

const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const varList = document.getElementById('varList')!;

document.getElementById('toggleLogs')?.addEventListener('click', async () => {
  showLogs = !showLogs;
  const logArea = document.getElementById('logArea');
  if (!logArea) return;
  if (showLogs) {
    try {
      const logs = await chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOGS' });
      logArea.textContent = (logs?.logs || []).join('\n');
      logArea.style.display = 'block';
    } catch (e) {
      logArea.textContent = 'Failed to fetch logs: ' + e;
      logArea.style.display = 'block';
    }
  } else {
    logArea.style.display = 'none';
  }
});

function updateStatus(connected: boolean, message?: string) {
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = message || (connected ? 'Connected' : 'Disconnected');
}

// Listen for updates from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SYNC_VARS_UPDATE') {
    renderVarList(msg.vars, msg.lists);
  }
  if (msg.type === 'REALTIME_CONNECTED') {
    updateStatus(true, 'Connected');
  }
  if (msg.type === 'REALTIME_DISCONNECTED') {
    updateStatus(false, 'Disconnected');
  }
});

function renderVarList(vars: Record<string, unknown>, lists: Array<{ name: string; count: number }>) {
  varList.innerHTML = '';

  const varEntries = Object.entries(vars || {});
  const listItems = lists || [];

  if (varEntries.length === 0 && listItems.length === 0) {
    varList.innerHTML = '<div style="color:#999; font-size:12px;">동기화 중인 변수가 없습니다.</div>';
    return;
  }

  varEntries.forEach(([name, value]) => {
    const item = document.createElement('div');
    item.className = 'var-item';
    item.innerHTML = `<span class="var-name">${name}</span> = <span class="var-value">${String(value)}</span>`;
    varList.appendChild(item);
  });

  listItems.forEach((list) => {
    const item = document.createElement('div');
    item.className = 'var-item';
    item.innerHTML = `<span class="var-name">${list.name}</span> [${list.count} items]`;
    varList.appendChild(item);
  });
}

function extractProjectId(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/(?:project|ws|iframe|embed|e|play|p)\/([^\/?#]+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

document.addEventListener('DOMContentLoaded', async () => {
  updateStatus(false, '연결 대기 중...');
  // Get current tab's project ID
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  let currentProjectId: string | null = null;
  if (tab?.url) {
    currentProjectId = extractProjectId(tab.url);
  }
  chrome.runtime.sendMessage({ type: 'POPUP_OPENED', projectId: currentProjectId });
});
