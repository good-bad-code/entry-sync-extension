// ========================================
// Message Protocol Types
// ========================================

// --- Injected Script ↔ Content Script (window.postMessage) ---
// (no projectUrl — content script adds it from page URL)

export interface EntryVarChangeMessage {
  type: 'ENTRY_VAR_CHANGE';
  name: string;
  value: string | number;
  timestamp: number;
}

export interface EntryListChangeMessage {
  type: 'ENTRY_LIST_CHANGE';
  name: string;
  operation: 'setArray' | 'appendValue' | 'deleteValue' | 'insertValue' | 'replaceValue';
  args: unknown[];
  timestamp: number;
}

export interface EntryReadyMessage {
  type: 'ENTRY_READY';
  projectUrl: string;
}

export interface ApplyVarUpdateMessage {
  type: 'APPLY_VAR_UPDATE';
  name: string;
  value: string | number;
}

export interface ApplyListUpdateMessage {
  type: 'APPLY_LIST_UPDATE';
  name: string;
  operation: string;
  args: unknown[];
}

// --- Content Script ↔ Service Worker ---
// (projectUrl added by content script from location.href)

export interface VarChangedMessage {
  type: 'VAR_CHANGED';
  projectUrl: string;
  name: string;
  value: string | number;
  timestamp: number;
}

export interface ListChangedMessage {
  type: 'LIST_CHANGED';
  projectUrl: string;
  name: string;
  operation: string;
  args: unknown[];
  timestamp: number;
}

export interface InitSyncMessage {
  type: 'INIT_SYNC';
  projectUrl: string;
}

export interface InitSyncResultMessage {
  type: 'INIT_SYNC_RESULT';
  vars: Record<string, string | number>;
  lists: Array<{ name: string; array: unknown[] }>;
}

export interface RemoteVarUpdateMessage {
  type: 'REMOTE_VAR_UPDATE';
  name: string;
  value: string | number;
  timestamp: number;
}

export interface RemoteListUpdateMessage {
  type: 'REMOTE_LIST_UPDATE';
  name: string;
  operation: string;
  args: unknown[];
  timestamp: number;
}

// --- Service Worker ↔ Offscreen Document ---

export interface RealtimeSendMessage {
  type: 'REALTIME_SEND';
  kind: 'var' | 'list';
  projectUrl: string;
  name: string;
  value?: string | number;
  operation?: string;
  args?: unknown[];
  timestamp: number;
}

export interface RealtimeSubscribeMessage {
  type: 'REALTIME_SUBSCRIBE';
  projectUrl: string;
}

export interface KeepAliveMessage {
  type: 'KEEPALIVE';
}

export type ServiceWorkerMessage =
  | VarChangedMessage
  | ListChangedMessage
  | InitSyncMessage
  | InitSyncResultMessage
  | RemoteVarUpdateMessage
  | RemoteListUpdateMessage
  | RealtimeSendMessage
  | RealtimeSubscribeMessage
  | KeepAliveMessage;
