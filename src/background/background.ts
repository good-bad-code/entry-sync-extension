import { SUPABASE_ANON_KEY, REST_API_URL } from '../config';

const SYNC_PREFIX = '?!';
function isSyncName(name: string): boolean {
  return name.startsWith(SYNC_PREFIX) && name !== SYNC_PREFIX;
}

const listOpLocks = new Map<string, Promise<void>>();

let offscreenCreated = false;

interface SyncState {
  vars: Record<string, string | number>;
  lists: Array<{ name: string; array: unknown[] }>;
}
const syncState = new Map<string, SyncState>();

function notifyPopup(projectUrl: string) {
  const state = syncState.get(projectUrl);
  if (!state) return;
  chrome.runtime.sendMessage({
    type: 'SYNC_VARS_UPDATE',
    vars: Object.fromEntries(Object.entries(state.vars).filter(([name]) => isSyncName(name))),
    lists: state.lists.filter(l => isSyncName(l.name)).map(l => ({ name: l.name, count: l.array.length })),
  });
}

async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'] as any,
      justification: 'Supabase Realtime WebSocket connection',
    });
    offscreenCreated = true;
  } catch (e: any) {
    if (e.message?.includes('already exists')) {
      offscreenCreated = true;
      return;
    }
    setTimeout(() => { offscreenCreated = false; }, 2000);
  }
}

// --- Supabase REST helpers ---

function headers() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  };
}

async function upsertVar(projectUrl: string, name: string, value: string | number) {
  try {
    await fetch(`${REST_API_URL}/sync_variables`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ project_url: projectUrl, name, value: String(value), updated_at: new Date().toISOString() }),
    });
  } catch {}
}

async function upsertList(projectUrl: string, name: string, array: unknown[]) {
  try {
    await fetch(`${REST_API_URL}/sync_lists`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ project_url: projectUrl, name, value: array, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

async function fetchVars(projectUrl: string): Promise<Record<string, string | number>> {
  try {
    const url = `${REST_API_URL}/sync_variables?project_url=eq.${encodeURIComponent(projectUrl)}&select=name,value`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return {};
    const rows: Array<{ name: string; value: string }> = await res.json();
    const result: Record<string, string | number> = {};
    for (const r of rows) {
      const num = Number(r.value);
      result[r.name] = isNaN(num) ? r.value : num;
    }
    return result;
  } catch { return {}; }
}

async function fetchLists(projectUrl: string): Promise<Array<{ name: string; array: unknown[] }>> {
  try {
    const url = `${REST_API_URL}/sync_lists?project_url=eq.${encodeURIComponent(projectUrl)}&select=name,value`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return [];
    const rows: Array<{ name: string; value: unknown[] }> = await res.json();
    return rows.map(r => ({ name: r.name, array: r.value }));
  } catch { return []; }
}

async function fetchSingleVar(projectUrl: string, name: string): Promise<string | number | null> {
  try {
    const url = `${REST_API_URL}/sync_variables?project_url=eq.${encodeURIComponent(projectUrl)}&name=eq.${encodeURIComponent(name)}&select=value`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const num = Number(rows[0].value);
    return isNaN(num) ? rows[0].value : num;
  } catch { return null; }
}

async function fetchSingleList(projectUrl: string, name: string): Promise<unknown[] | null> {
  try {
    const url = `${REST_API_URL}/sync_lists?project_url=eq.${encodeURIComponent(projectUrl)}&name=eq.${encodeURIComponent(name)}&select=value`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0].value || [];
  } catch { return null; }
}

async function updateListWithOp(projectUrl: string, name: string, op: string, args: unknown[]) {
  try {
    const url = `${REST_API_URL}/sync_lists?project_url=eq.${encodeURIComponent(projectUrl)}&name=eq.${encodeURIComponent(name)}&select=value`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return;
    const rows = await res.json();
    const current: unknown[] = (Array.isArray(rows) && rows.length > 0) ? rows[0].value || [] : [];
    let next: unknown[];
    switch (op) {
      case 'appendValue': next = [...current, args[0]]; break;
      case 'deleteValue': next = current.filter((_, i) => i !== Number(args[0])); break;
      case 'insertValue': next = [...current.slice(0, Number(args[0])), args[1], ...current.slice(Number(args[0]))]; break;
      case 'replaceValue': next = current.map((item, i) => i === Number(args[0]) ? args[1] : item); break;
      case 'setArray': next = (args[0] as unknown[]) || []; break;
      default: next = current;
    }
    await upsertList(projectUrl, name, next);
  } catch {}
}

async function subscribeOffscreen(projectUrl: string) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'REALTIME_SUBSCRIBE', projectUrl });
}

async function sendBroadcast(projectUrl: string, msg: { kind: 'var' | 'list'; name: string; value?: string | number; operation?: string; args?: unknown[]; timestamp: number; _senderTabId?: number }) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'REALTIME_SEND', projectUrl, ...msg });
}

/**
 * Serialize list operations per (projectUrl, name) key to prevent race conditions.
 * Each new operation waits for the previous one to complete before starting.
 */
function enqueueListOp(projectUrl: string, name: string, fn: () => Promise<void>): Promise<void> {
  const key = `${projectUrl}:${name}`;
  const prev = listOpLocks.get(key) || Promise.resolve();
  // Chain: wait for previous, then run this one (even if previous failed)
  const next = prev.then(fn, fn);
  listOpLocks.set(key, next);
  const cleanup = () => {
    if (listOpLocks.get(key) === next) listOpLocks.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// --- Message routing ---

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'INJECT_MAIN_SCRIPT': {
      const tabId = sender.tab?.id;
      if (tabId) {
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['inject.js'],
        }).then(() => {
          console.log('[EntrySync] inject.js injected into MAIN world, tab:', tabId);
        }).catch((err) => {
          console.error('[EntrySync] Failed to inject script:', err);
        });
      }
      break;
    }
    case 'LIST_CHANGED': {
      await enqueueListOp(msg.projectUrl, msg.name, async () => {
        await updateListWithOp(msg.projectUrl, msg.name, msg.operation, msg.args);
        const finalArray = await fetchSingleList(msg.projectUrl, msg.name);
        if (finalArray === null) return;
        sendBroadcast(msg.projectUrl, {
          kind: 'list',
          name: msg.name,
          operation: 'setArray',
          args: [finalArray],
          timestamp: Date.now(),
          _senderTabId: sender.tab?.id,
        });
        if (isSyncName(msg.name)) {
          const st = syncState.get(msg.projectUrl);
          if (st) {
            const idx = st.lists.findIndex(l => l.name === msg.name);
            if (idx >= 0) st.lists.splice(idx, 1, { name: msg.name, array: finalArray });
            else st.lists.push({ name: msg.name, array: finalArray });
          }
        }
        notifyPopup(msg.projectUrl);
      });
      break;
    }
    case 'VAR_CHANGED': {
      // 1. Upsert to DB
      await upsertVar(msg.projectUrl, msg.name, msg.value);
      
      // 2. DB read-after-write: fetch authoritative value
      const finalValue = await fetchSingleVar(msg.projectUrl, msg.name);
      if (finalValue === null) break;
      
      // 3. Broadcast DB value via Realtime (with _senderTabId)
      sendBroadcast(msg.projectUrl, {
        kind: 'var',
        name: msg.name,
        value: finalValue,
        timestamp: Date.now(),
        _senderTabId: sender.tab?.id,
      });
      
      // 4. Update local syncState
      const st = syncState.get(msg.projectUrl);
      if (st) { if (isSyncName(msg.name)) st.vars[msg.name] = finalValue; }
      notifyPopup(msg.projectUrl);
      break;
    }
    case 'INIT_SYNC': {
      (async () => {
        const [dbVars, dbLists] = await Promise.all([
          fetchVars(msg.projectUrl),
          fetchLists(msg.projectUrl),
        ]);
        
        const filteredVars = Object.fromEntries(Object.entries(dbVars).filter(([name]) => isSyncName(name)));
        const filteredLists = dbLists.filter(l => isSyncName(l.name));
        syncState.set(msg.projectUrl, { vars: filteredVars, lists: filteredLists });
        chrome.runtime.sendMessage({ type: 'INIT_SYNC_RESULT', vars: dbVars, lists: dbLists });
        notifyPopup(msg.projectUrl);
      })();
      subscribeOffscreen(msg.projectUrl);
      break;
    }
    case 'POPUP_OPENED':
      // Send current state to the popup that just opened
      syncState.forEach((_, url) => notifyPopup(url));
      break;
    case 'KEEPALIVE':
      break;
    case 'REMOTE_VAR_UPDATE':
    case 'REMOTE_LIST_UPDATE': {
      // Forward to all tabs EXCEPT the one that originated the broadcast
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id && tab.id !== (msg as any)._skipTabId) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
      break;
    }
  }
  return true;
});
