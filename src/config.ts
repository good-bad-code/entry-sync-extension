// ========================================
// Supabase Configuration (hardcoded)
// ========================================

export const SUPABASE_URL = 'https://qjjfyuxomsuflczcgktf.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqamZ5dXhvbXN1ZmxjemNna3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDAyOTksImV4cCI6MjA5NjcxNjI5OX0.YJ-6Nu4s3u-c87dG7ZlkWXtcMNzgulb8YewoYGxEPg4';

export const REALTIME_CHANNEL = 'entry-sync';

// Realtime WebSocket URL derived from HTTP URL
export function getRealtimeUrl(): string {
  const ref = SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0];
  return `wss://${ref}.supabase.co/realtime/v1`;
}

// REST API base
export const REST_API_URL = `${SUPABASE_URL}/rest/v1`;
