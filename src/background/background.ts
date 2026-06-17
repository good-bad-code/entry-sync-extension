import { SUPABASE_ANON_KEY, REST_API_URL } from '../config';

function extractProjectId(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/(?:project|ws|iframe|embed|e|play|p)\/([^\/?#]+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

const DBG_LOGS: string[] = [];
const MAX_DBG_LOGS = 200;

function dbLog(...args: unknown[]) {
  const msg = `[EntrySync:DB] ${args.join(' ')}`;
  console.log(msg);
  DBG_LOGS.push(`${new Date().toISOString()} ${msg}`);
  if (DBG_LOGS.length > MAX_DBG_LOGS) DBG_LOGS.splice(0, DBG_LOGS.length - MAX_DBG_LOGS);
  // Persist to storage for popup
  chrome.storage.session.set({ debugLogs: DBG_LOGS.slice(-100) }).catch((e) => { console.error('[EntrySync]', e); });
}

const SYNC_PREFIX = '?!';
function isSyncName(name: string): boolean {
  return name.startsWith(SYNC_PREFIX) && name !== SYNC_PREFIX;
}

const listOpLocks = new Map<string, Promise<void>>();
const varOpLocks = new Map<string, Promise<void>>();

let offscreenCreated = false;

interface SyncState {
  vars: Record<string, string | number>;
  lists: Array<{ name: string; array: unknown[] }>;
}
const syncState = new Map<string, SyncState>();

function notifyPopup(projectId: string) {
  const state = syncState.get(projectId);
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

function headers(projectId?: string) {
  const h: Record<string, string> = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  };
  if (projectId) {
    h['x-project-id'] = projectId;
  }
  return h;
}

async function upsertVar(projectId: string, name: string, value: string | number) {
  try {
    const res = await fetch(`${REST_API_URL}/sync_variables?on_conflict=project_url,name`, {
      method: 'POST',
      headers: headers(projectId),
      body: JSON.stringify({ project_id: projectId, project_url: `https://playentry.org/ws/${projectId}`, name, value: String(value), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) dbLog(`upsertVar FAIL: ${name}=${value} → HTTP ${res.status} ${res.statusText}`);
    else dbLog(`upsertVar OK: ${name}=${value}  id="${projectId}"`);
  } catch (e) { dbLog(`upsertVar ERROR: ${name}=${value}  id="${projectId}" →`, e); }
}

async function upsertList(projectId: string, name: string, array: unknown[]) {
  try {
    const res = await fetch(`${REST_API_URL}/sync_lists?on_conflict=project_url,name`, {
      method: 'POST',
      headers: headers(projectId),
      body: JSON.stringify({ project_id: projectId, name, value: array, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) dbLog(`upsertList FAIL: ${name} → HTTP ${res.status} ${res.statusText}`);
    else dbLog(`upsertList OK: ${name} [${array.length} items]  id="${projectId}"`);
  } catch (e) { dbLog(`upsertList ERROR: ${name}  id="${projectId}" →`, e); }
}

async function fetchVars(projectId: string): Promise<Record<string, string | number>> {
  try {
    dbLog(`fetchVars: projectId="${projectId}"`);
    const url = `${REST_API_URL}/sync_variables?project_id=eq.${encodeURIComponent(projectId)}&select=name,value`;
    const res = await fetch(url, { headers: headers(projectId) });
    if (!res.ok) { dbLog(`fetchVars FAIL → HTTP ${res.status} ${res.statusText}`); return {}; }
    const rows: Array<{ name: string; value: string }> = await res.json();
    dbLog(`fetchVars OK: ${rows.length} vars  id="${projectId}"`);
    const result: Record<string, string | number> = {};
    for (const r of rows) {
      const num = Number(r.value);
      result[r.name] = isNaN(num) ? r.value : num;
    }
    return result;
  } catch (e) { dbLog(`fetchVars ERROR →`, e); return {}; }
}

async function fetchLists(projectId: string): Promise<Array<{ name: string; array: unknown[] }>> {
  try {
    const url = `${REST_API_URL}/sync_lists?project_id=eq.${encodeURIComponent(projectId)}&select=name,value`;
    const res = await fetch(url, { headers: headers(projectId) });
    if (!res.ok) { dbLog(`fetchLists FAIL → HTTP ${res.status} ${res.statusText}`); return []; }
    const rows: Array<{ name: string; value: unknown[] }> = await res.json();
    dbLog(`fetchLists OK: ${rows.length} lists  id="${projectId}"`);
    return rows.map(r => ({ name: r.name, array: r.value }));
  } catch (e) { dbLog(`fetchLists ERROR →`, e); return []; }
}

async function fetchSingleVar(projectId: string, name: string): Promise<string | number | null> {
  try {
    const url = `${REST_API_URL}/sync_variables?project_id=eq.${encodeURIComponent(projectId)}&name=eq.${encodeURIComponent(name)}&select=value`;
    const res = await fetch(url, { headers: headers(projectId) });
    if (!res.ok) { dbLog(`fetchSingleVar FAIL: ${name} → HTTP ${res.status} ${res.statusText}`); return null; }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) { dbLog(`fetchSingleVar NOT FOUND: ${name}`); return null; }
    dbLog(`fetchSingleVar OK: ${name} = ${rows[0].value}`);
    const num = Number(rows[0].value);
    return isNaN(num) ? rows[0].value : num;
  } catch (e) { dbLog(`fetchSingleVar ERROR: ${name} →`, e); return null; }
}

async function fetchSingleList(projectId: string, name: string): Promise<unknown[] | null> {
  try {
    const url = `${REST_API_URL}/sync_lists?project_id=eq.${encodeURIComponent(projectId)}&name=eq.${encodeURIComponent(name)}&select=value`;
    const res = await fetch(url, { headers: headers(projectId) });
    if (!res.ok) { dbLog(`fetchSingleList FAIL: ${name} → HTTP ${res.status} ${res.statusText}`); return null; }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) { dbLog(`fetchSingleList NOT FOUND: ${name}`); return null; }
    dbLog(`fetchSingleList OK: ${name} [${(rows[0].value || []).length} items]`);
    return rows[0].value || [];
  } catch (e) { dbLog(`fetchSingleList ERROR: ${name} →`, e); return null; }
}

async function updateListWithOp(projectId: string, name: string, op: string, args: unknown[]) {
  try {
    dbLog(`updateListWithOp: ${name} op=${op} args=${JSON.stringify(args)}`);
    const url = `${REST_API_URL}/sync_lists?project_id=eq.${encodeURIComponent(projectId)}&name=eq.${encodeURIComponent(name)}&select=value`;
    const res = await fetch(url, { headers: headers(projectId) });
    if (!res.ok) { dbLog(`updateListWithOp FETCH FAIL: ${name} → HTTP ${res.status}`); return; }
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
    dbLog(`updateListWithOp: ${name} ${op} → ${next.length} items`);
    await upsertList(projectId, name, next);
  } catch (e) { dbLog(`updateListWithOp ERROR: ${name} →`, e); }
}

async function subscribeOffscreen(projectId: string) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'REALTIME_SUBSCRIBE', projectId });
}

async function sendBroadcast(projectId: string, msg: { kind: 'var' | 'list'; name: string; value?: string | number; operation?: string; args?: unknown[]; timestamp: number; _senderTabId?: number }) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'REALTIME_SEND', projectId, ...msg });
}

/**
 * Serialize list operations per (projectUrl, name) key to prevent race conditions.
 * Each new operation waits for the previous one to complete before starting.
 */
function enqueueListOp(projectId: string, name: string, fn: () => Promise<void>): Promise<void> {
  const key = `${projectId}:${name}`;
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

/**
 * Serialize variable operations per (projectUrl, name) key to prevent race conditions.
 * Each new operation waits for the previous one to complete before starting.
 */
function enqueueVarOp(projectId: string, name: string, fn: () => Promise<void>): Promise<void> {
  const key = `${projectId}:${name}`;
  const prev = varOpLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  varOpLocks.set(key, next);
  const cleanup = () => {
    if (varOpLocks.get(key) === next) varOpLocks.delete(key);
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
      // ?! (bare prefix) is health check only — never sync to DB
      if (!isSyncName(msg.name)) break;
      const projectId = msg.projectId || extractProjectId(msg.projectUrl);
      if (!projectId) break;
      
      // OPTIMISTIC: update local state immediately for fast popup response
      const optimisticSt = syncState.get(projectId);
      if (optimisticSt) {
        if (isSyncName(msg.name)) {
          const idx = optimisticSt.lists.findIndex(l => l.name === msg.name);
          // For optimistic, we just indicate the operation happened
          // The authoritative value comes from fetchSingleList below
        }
        notifyPopup(projectId);
      }
      
      await enqueueListOp(projectId, msg.name, async () => {
        await updateListWithOp(projectId, msg.name, msg.operation, msg.args);
        const finalArray = await fetchSingleList(projectId, msg.name);
        if (finalArray === null) return;
        sendBroadcast(projectId, {
          kind: 'list',
          name: msg.name,
          operation: 'setArray',
          args: [finalArray],
          timestamp: Date.now(),
          _senderTabId: sender.tab?.id,
        });
        if (isSyncName(msg.name)) {
          const st = syncState.get(projectId);
          if (st) {
            const idx = st.lists.findIndex(l => l.name === msg.name);
            if (idx >= 0) st.lists.splice(idx, 1, { name: msg.name, array: finalArray });
            else st.lists.push({ name: msg.name, array: finalArray });
          }
        }
        notifyPopup(projectId);
      });
      break;
    }
    case 'VAR_CHANGED': {
      // ?! (bare prefix) is health check only — never sync to DB
      if (!isSyncName(msg.name)) break;
      if (msg.name === SYNC_PREFIX) break; // belt-and-suspenders
      const projectId = msg.projectId || extractProjectId(msg.projectUrl);
      if (!projectId) break;
      
      // OPTIMISTIC: update local state immediately for fast popup response
      const optimisticSt = syncState.get(projectId);
      if (optimisticSt) {
        if (isSyncName(msg.name)) optimisticSt.vars[msg.name] = msg.value;
        notifyPopup(projectId);
      }
      
      await enqueueVarOp(projectId, msg.name, async () => {
        await upsertVar(projectId, msg.name, msg.value);
        const finalValue = await fetchSingleVar(projectId, msg.name);
        if (finalValue === null) return;
        sendBroadcast(projectId, {
          kind: 'var',
          name: msg.name,
          value: finalValue,
          timestamp: Date.now(),
          _senderTabId: sender.tab?.id,
        });
        const st = syncState.get(projectId);
        if (st) { if (isSyncName(msg.name)) st.vars[msg.name] = finalValue; }
        notifyPopup(projectId);
      });
      break;
    }
    case 'INIT_SYNC': {
      const projectId = msg.projectId || extractProjectId(msg.projectUrl);
      if (!projectId) break;
      const tabId = sender.tab?.id;
      (async () => {
        const [dbVars, dbLists] = await Promise.all([
          fetchVars(projectId),
          fetchLists(projectId),
        ]);
        
        const filteredVars = Object.fromEntries(Object.entries(dbVars).filter(([name]) => isSyncName(name)));
        const filteredLists = dbLists.filter(l => isSyncName(l.name));
        syncState.set(projectId, { vars: filteredVars, lists: filteredLists });
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'INIT_SYNC_RESULT', vars: dbVars, lists: dbLists });
        } else {
          chrome.runtime.sendMessage({ type: 'INIT_SYNC_RESULT', vars: dbVars, lists: dbLists });
        }
        notifyPopup(projectId);
      })();
      subscribeOffscreen(projectId);
      break;
    }
    case 'POPUP_OPENED': {
      const requestedProjectId = msg.projectId;
      if (requestedProjectId && syncState.has(requestedProjectId)) {
        notifyPopup(requestedProjectId);
      }
      break;
    }
    case 'KEEPALIVE':
      break;
    case 'GET_DEBUG_LOGS':
      sendResponse({ logs: DBG_LOGS.slice(-100) });
      return true;
    case 'REMOTE_VAR_UPDATE':
    case 'REMOTE_LIST_UPDATE': {
      // Forward to all tabs EXCEPT the one that originated the broadcast
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id && tab.id !== (msg as any)._skipTabId) {
          chrome.tabs.sendMessage(tab.id, msg).catch((e) => { console.error('[EntrySync]', e); });
        }
      }
      break;
    }
  }
  return true;
});
