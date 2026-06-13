import {
  createClient,
  createChannel,
  subscribeToChannel as subscribeChannel,
  onBroadcast,
  sendBroadcast as broadcastMessage,
  removeChannel,
} from '../lib/realtime-client';
import { SUPABASE_ANON_KEY, getRealtimeUrl } from '../config';

const realtimeUrl = getRealtimeUrl();

let client: ReturnType<typeof createClient> | null = null;
const channels = new Map<string, ReturnType<typeof createChannel>>();

function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function ensureClient() {
  if (client) return client;
  console.log('[EntrySync:Offscreen] Creating RealtimeClient, URL:', realtimeUrl);
  try {
    client = createClient(realtimeUrl, SUPABASE_ANON_KEY);
    console.log('[EntrySync:Offscreen] RealtimeClient created');
  } catch (e) {
    console.error('[EntrySync:Offscreen] Failed to create RealtimeClient:', e);
  }
  return client;
}

function subscribeProjectChannel(projectUrl: string) {
  const c = ensureClient();
  if (!c) {
    console.error('[EntrySync:Offscreen] No client available');
    return;
  }

  const channelName = `entry-sync:${hashUrl(projectUrl)}`;
  console.log('[EntrySync:Offscreen] Subscribing to channel:', channelName);

  const existing = channels.get(projectUrl);
  if (existing) {
    removeChannel(c, existing);
  }

  const channel = createChannel(c, channelName);
  if (!channel) {
    console.error('[EntrySync:Offscreen] Failed to create channel');
    return;
  }

  onBroadcast(channel, 'var:update', (payload: any) => {
    const { name, value, timestamp, _senderTabId } = payload.payload || payload;
    console.log('[EntrySync:Offscreen] Received var:update broadcast:', name, value);
    chrome.runtime.sendMessage({
      type: 'REMOTE_VAR_UPDATE', name, value, timestamp,
      _skipTabId: _senderTabId,
    });
  });

  onBroadcast(channel, 'list:update', (payload: any) => {
    const { name, operation, args, timestamp, _senderTabId } = payload.payload || payload;
    console.log('[EntrySync:Offscreen] Received list:update broadcast:', name, operation);
    chrome.runtime.sendMessage({
      type: 'REMOTE_LIST_UPDATE', name, operation, args, timestamp,
      _skipTabId: _senderTabId,
    });
  });

  subscribeChannel(channel, (status: string) => {
    console.log('[EntrySync:Offscreen] Channel status:', channelName, status);
    if (status === 'SUBSCRIBED') {
      console.log(`[EntrySync:Offscreen] Successfully subscribed to ${channelName}`);
    } else if (status === 'CHANNEL_ERROR') {
      console.error('[EntrySync:Offscreen] Channel error for:', channelName);
    }
  });

  channels.set(projectUrl, channel);
}

function handleSend(msg: { kind: string; projectUrl: string; name: string; value?: unknown; operation?: string; args?: unknown[]; timestamp: number; _senderTabId?: number }) {
  let channel = channels.get(msg.projectUrl);
  if (!channel) {
    console.log('[EntrySync:Offscreen] No channel yet, subscribing...');
    subscribeProjectChannel(msg.projectUrl);
    channel = channels.get(msg.projectUrl);
  }
  if (!channel) {
    console.error('[EntrySync:Offscreen] Still no channel after subscribe, cannot broadcast');
    return;
  }

  const event = msg.kind === 'var' ? 'var:update' : 'list:update';
  const payload: Record<string, unknown> = { name: msg.name, timestamp: msg.timestamp };

  if (msg.kind === 'var') {
    payload.value = msg.value;
  } else {
    payload.operation = msg.operation;
    payload.args = msg.args;
  }

  if (msg._senderTabId !== undefined) {
    payload._senderTabId = msg._senderTabId;
  }

  console.log('[EntrySync:Offscreen] Broadcasting:', event, payload);
  try {
    broadcastMessage(channel, event, payload);
    console.log('[EntrySync:Offscreen] Broadcast sent successfully');
  } catch (e) {
    console.error('[EntrySync:Offscreen] Broadcast failed:', e);
  }
}

chrome.runtime.onMessage.addListener((msg: any) => {
  switch (msg.type) {
    case 'REALTIME_SEND':
      handleSend(msg);
      break;
    case 'REALTIME_SUBSCRIBE':
      subscribeProjectChannel(msg.projectUrl);
      break;
  }
  return false;
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'KEEPALIVE' });
}, 20000);
