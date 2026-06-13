/**
 * Thin wrapper around @supabase/realtime-js
 * Isolates API differences in one place
 */

import { RealtimeClient, RealtimeChannel } from '@supabase/realtime-js';

export type RealtimeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface BroadcastPayload {
  type: 'broadcast';
  event: string;
  payload: Record<string, unknown>;
}

export function createClient(realtimeUrl: string, anonKey: string): RealtimeClient {
  return new RealtimeClient(realtimeUrl, {
    params: { apikey: anonKey },
  });
}

export function getRealtimeUrl(supabaseUrl: string): string {
  try {
    const ref = supabaseUrl.replace(/^https?:\/\//, '').split('.')[0];
    return `wss://${ref}.supabase.co/realtime/v1`;
  } catch {
    return '';
  }
}

export function createChannel(
  client: RealtimeClient,
  channelName: string
): RealtimeChannel {
  return client.channel(channelName);
}

export function subscribeToChannel(
  channel: RealtimeChannel,
  callback: (status: RealtimeStatus) => void
): void {
  channel.subscribe(callback);
}

export function onBroadcast(
  channel: RealtimeChannel,
  event: string,
  callback: (payload: Record<string, unknown>) => void
): void {
  channel.on('broadcast', { event }, callback);
}

export function sendBroadcast(
  channel: RealtimeChannel,
  event: string,
  payload: Record<string, unknown>
): void {
  channel.send({
    type: 'broadcast',
    event,
    payload,
  });
}

export function removeChannel(client: RealtimeClient, channel: RealtimeChannel): void {
  client.removeChannel(channel);
}

export function disconnectClient(client: RealtimeClient): void {
  client.disconnect();
}
