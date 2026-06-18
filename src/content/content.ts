/**
 * Content Script — runs in isolated world in ALL frames (all_frames: true)
 *
 * Injects inject.js into ALL pages that may have Entry runtime:
 *   /iframe/  — Entry runtime page (already covered)
 *   /ws/      — Entry editor workspace page
 *   /         — main/landing page
 *   /project/{id} — project detail/play page
 *
 * inject.js will gracefully check for window.Entry before hooking.
 *
 * Message bridge:
 *   Injected Script (main world)  ←window.postMessage→  Content Script (isolated)  ←chrome.runtime→  Service Worker
 */

function extractProjectId(url: string): string | null {
  try {
    const u = new URL(url);
    // Match /project/xxx, /ws/xxx, /iframe/xxx, /embed/xxx, /e/xxx, /play/xxx, /p/xxx
    const match = u.pathname.match(/^\/(?:project|ws|iframe|embed|e|play|p)\/([^\/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const projectUrl = window.location.href;
const projectId = extractProjectId(projectUrl);

function log(...args: unknown[]) {
  console.log('[EntrySync:Content]', ...args);
}

log('content.js loaded, frame:', window.location.pathname, 'projectId:', projectId);

// --- Inject inject.js into the main world on ALL Entry-related pages ---
if (
  window.location.pathname.startsWith('/iframe/') ||
  window.location.pathname.startsWith('/ws/') ||
  window.location.pathname.startsWith('/project/') ||
  window.location.pathname === '/' ||
  /^\/[^\/]+$/.test(window.location.pathname)  // /{id} (some Entry pages)
) {
  log('Injecting inject.js into main world');
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => {
    log('inject.js loaded and executed');
    script.remove();
  };
  script.onerror = (err) => {
    log('inject.js FAILED to load:', err);
  };
  (document.head || document.documentElement).appendChild(script);
}

// If we can't extract project ID, don't set up message bridge for sync
if (!projectId) {
  log('No project ID found at:', projectUrl);
}

// --- Message bridge (only on project pages with a valid projectId) ---
if (projectId) {

// Injected Script -> Service Worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;

  log('Received message from inject script:', msg.type, msg.name || '');

  const sendMsg = (payload: any) => {
    log('Sending to service worker:', payload.type, payload.name || '');
    chrome.runtime.sendMessage(payload).catch((err) => {
      if (err.message?.includes('Extension context invalidated')) {
        log('Extension context invalidated');
      } else {
        log('Error sending message to service worker:', err);
      }
    });
  };

  switch (msg.type) {
    case 'ENTRY_VAR_CHANGE':
      sendMsg({
        type: 'VAR_CHANGED',
        projectId,
        projectUrl,
        name: msg.name,
        value: msg.value,
        timestamp: msg.timestamp,
      });
      break;

    case 'ENTRY_LIST_CHANGE':
      sendMsg({
        type: 'LIST_CHANGED',
        projectId,
        projectUrl,
        name: msg.name,
        operation: msg.operation,
        args: msg.args,
        timestamp: msg.timestamp,
      });
      break;

    case 'ENTRY_READY':
      sendMsg({
        type: 'INIT_SYNC',
        projectId,
        projectUrl,
      });
      break;
  }
});

} // end if (projectId)

// Service Worker -> Injected Script
chrome.runtime.onMessage.addListener((msg) => {
  log('Received message from service worker:', msg.type, msg.name || '');

  switch (msg.type) {
    case 'REMOTE_VAR_UPDATE':
      log('Forwarding to inject script: APPLY_VAR_UPDATE', msg.name, '=', msg.value);
      window.postMessage({ type: 'APPLY_VAR_UPDATE', name: msg.name, value: msg.value }, '*');
      break;

    case 'REMOTE_LIST_UPDATE':
      log('Forwarding to inject script: APPLY_LIST_UPDATE', msg.name, msg.operation);
      window.postMessage({ type: 'APPLY_LIST_UPDATE', name: msg.name, operation: msg.operation, args: msg.args }, '*');
      break;

    case 'INIT_SYNC_RESULT':
      // Forward as a single batch message — inject.ts's dedicated
      // INIT_SYNC_RESULT handler (in listenForRemoteUpdates) applies
      // all values atomically under applyingRemoteVar + applyingRemoteList
      // flags. Previously we split into individual APPLY_VAR_UPDATE/
      // APPLY_LIST_UPDATE messages, which caused a race: Entry's own
      // initialization could overwrite values between individual messages.
      log('Forwarding to inject script: INIT_SYNC_RESULT —', Object.keys(msg.vars || {}).length, 'vars,', (msg.lists || []).length, 'lists');
      window.postMessage({
        type: 'INIT_SYNC_RESULT',
        vars: msg.vars,
        lists: msg.lists,
      }, '*');
      break;
  }
});

export {};
