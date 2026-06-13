/**
 * Popup Script — simplified status display only
 */

const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const varList = document.getElementById('varList')!;

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

document.addEventListener('DOMContentLoaded', () => {
  updateStatus(false, '연결 대기 중...');
  // Request current status from service worker
  chrome.runtime.sendMessage({ type: 'POPUP_OPENED' });
});
