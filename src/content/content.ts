/**
 * Content Script — runs in isolated world in ALL frames (all_frames: true)
 *
 * Injects inject.js into ALL pages that may have Entry runtime:
 *   /iframe/  — Entry runtime page (already covered)
 *   /ws/      — Entry editor workspace page
 *   /         — main/landing page
 *   /{id}     — project detail/play page (single path segment)
 *
 * inject.js will gracefully check for window.Entry before hooking.
 *
 * Message bridge:
 *   Injected Script (main world)  ←window.postMessage→  Content Script (isolated)  ←chrome.runtime→  Service Worker
 */

const projectUrl = window.location.href;

console.log('[EntrySync] content.js loaded, frame:', window.location.pathname);

// --- Inject inject.js into the main world on ALL Entry-related pages ---
if (
  window.location.pathname.startsWith('/iframe/') ||
  window.location.pathname.startsWith('/ws/') ||
  window.location.pathname === '/' ||
  /^\/[^\/]+$/.test(window.location.pathname)  // /{project-id} detail pages
) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => {
    console.log('[EntrySync] inject.js injected into iframe main world');
    script.remove();
  };
  script.onerror = (err) => {
    console.error('[EntrySync] Failed to inject inject.js:', err);
  };
  (document.head || document.documentElement).appendChild(script);
}

// --- Message bridge ---

// Injected Script -> Service Worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;

  const sendMsg = (payload: any) => {
    chrome.runtime.sendMessage(payload).catch((err) => {
      if (err.message?.includes('Extension context invalidated')) {
        console.warn('[EntrySync] Extension context invalidated');
      }
    });
  };

  switch (msg.type) {
    case 'ENTRY_VAR_CHANGE':
      sendMsg({
        type: 'VAR_CHANGED',
        projectUrl,
        name: msg.name,
        value: msg.value,
        timestamp: msg.timestamp,
      });
      break;

    case 'ENTRY_LIST_CHANGE':
      sendMsg({
        type: 'LIST_CHANGED',
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
        projectUrl,
      });
      break;
  }
});

// Service Worker -> Injected Script
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'REMOTE_VAR_UPDATE':
      window.postMessage({ type: 'APPLY_VAR_UPDATE', name: msg.name, value: msg.value }, '*');
      break;

    case 'REMOTE_LIST_UPDATE':
      window.postMessage({ type: 'APPLY_LIST_UPDATE', name: msg.name, operation: msg.operation, args: msg.args }, '*');
      break;

    case 'INIT_SYNC_RESULT':
      // Forward as a single batch message — inject.ts's dedicated
      // INIT_SYNC_RESULT handler (in listenForRemoteUpdates) applies
      // all values atomically under applyingRemoteVar + applyingRemoteList
      // flags. Previously we split into individual APPLY_VAR_UPDATE/
      // APPLY_LIST_UPDATE messages, which caused a race: Entry's own
      // initialization could overwrite values between individual messages.
      window.postMessage({
        type: 'INIT_SYNC_RESULT',
        vars: msg.vars,
        lists: msg.lists,
      }, '*');
      break;
  }
});
