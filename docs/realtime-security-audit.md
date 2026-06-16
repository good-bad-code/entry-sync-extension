# Realtime Channel Isolation Security Audit

**Date:** 2026-06-16
**Auditor:** Sisyphus-Junior
**Status:** Draft

## 1. Executive Summary

The Entry Sync extension uses Supabase Realtime Broadcast to synchronize variable/list state across browser tabs for the same project. The current implementation has **no access control on Realtime channels** — any client with the Supabase anon key can subscribe to any `entry-sync:{projectId}` channel and receive all broadcast messages for that project.

Since writes go through the REST API (which now has RLS via `x-project-id` header), Realtime broadcasts are **read-only for data flow**. The primary risk is **information disclosure**: an attacker could eavesdrop on another project's real-time variable changes.

**Verdict:** Acceptable for the current use case (personal extension, cross-tab sync), but should be revisited if the extension is used in multi-tenant or production contexts.

---

## 2. Current Architecture

### 2.1 Channel Subscription Flow

```
Extension Tab A                    Offscreen Document              Supabase Realtime
     │                                    │                              │
     │  REALTIME_SUBSCRIBE(projectId)     │                              │
     │──────────────────────────────────► │                              │
     │                                    │  createClient(url, anonKey)  │
     │                                    │─────────────────────────────►│
     │                                    │                              │
     │                                    │  channel("entry-sync:{id}")  │
     │                                    │─────────────────────────────►│
     │                                    │                              │
     │  REMOTE_VAR_UPDATE                 │                              │
     │◄───────────────────────────────────│  broadcast("var:update",...) │
     │                                    │◄─────────────────────────────│
```

### 2.2 Key Code Locations

| Component | File | Line(s) | Description |
|-----------|------|---------|-------------|
| Client creation | `src/lib/realtime-client.ts` | 16-19 | `new RealtimeClient(url, { params: { apikey: anonKey } })` |
| Channel creation | `src/lib/realtime-client.ts` | 31-36 | `client.channel(channelName)` — no `private: true` config |
| Channel subscription | `src/offscreen/offscreen.ts` | 28-77 | Subscribes to `entry-sync:{projectId}` |
| Broadcast sending | `src/offscreen/offscreen.ts` | 79-112 | Sends `var:update` and `list:update` events |
| Channel name format | `src/offscreen/offscreen.ts` | 35 | `` `entry-sync:${projectId}` `` |
| API key source | `src/config.ts` | 5-7 | Hardcoded `SUPABASE_ANON_KEY` |

### 2.3 Authentication Model

- **WebSocket connection**: Authenticated with `SUPABASE_ANON_KEY` only
- **Channel subscription**: No JWT, no auth token, no `private: true` flag
- **REST API**: Now secured with `x-project-id` header + RLS (Task T10)
- **Realtime Broadcast**: No access control whatsoever

---

## 3. Supabase Realtime Broadcast Security Model

### 3.1 Default Behavior (Current Configuration)

Per [Supabase Realtime documentation](https://supabase.com/docs/guides/realtime/broadcast):

> **Public channel (default):** Anyone can subscribe to that topic without authentication.

In the default (public) mode:
- **Channel name is routing, not access control.** Any client with the anon key can subscribe to any channel name.
- **No per-message authorization.** Every subscriber receives every message published to the channel.
- **No RLS enforcement.** The server does not check whether the subscriber should be allowed to read the payload.

### 3.2 Private Channel Mode (Available But Not Used)

Supabase supports private channels with RLS authorization since 2024:

1. **Flag**: Set `config: { private: true }` when creating the channel
2. **RLS Policies**: Create policies on `realtime.messages` table
3. **JWT Enforcement**: Authorization is checked against the user's JWT claims at subscription time
4. **Helper**: `realtime.topic()` returns the channel name for use in RLS policies

When private mode is active:
```sql
-- Example RLS policy: user can only subscribe to their own channel
create policy "user can read own channel"
on "realtime"."messages"
for select
to authenticated
using (
  extension = 'broadcast'
  and split_part(topic, ':', 2) = (select auth.uid()::text)
);
```

### 3.3 Key Limitation for Entry Sync

The Entry Sync extension has **no authentication** — it uses the anon key directly without any user JWT. This means:

- Even with `private: true`, there is no `auth.uid()` to check against
- The extension would need anonymous auth or some form of user identity to use private channels effectively
- RLS policies that use `auth.uid()` cannot work without auth

---

## 4. Threat Model

### 4.1 Threat: Cross-Project Channel Eavesdropping

| Attribute | Detail |
|-----------|--------|
| **Threat** | Attacker subscribes to `entry-sync:{victimProjectId}` and receives all broadcasts |
| **Precondition** | Attacker knows victim's project ID (hex string like `5e5b055fe282b5008b442394`) |
| **Difficulty** | Low — project IDs are somewhat guessable (24 hex chars = 96 bits, but often exposed in URLs) |
| **Impact** | Medium — attacker sees variable names, values, and list operations in real time |

**Attack scenario:**
1. Victim visits `https://entry.house/project/5e5b055fe282b5008b442394`
2. Attacker extracts project ID from URL
3. Attacker opens DevTools and runs:
   ```js
   const channel = supabase.channel('entry-sync:5e5b055fe282b5008b442394');
   channel.on('broadcast', { event: '*' }, (payload) => console.log(payload));
   channel.subscribe();
   ```
4. Attacker now sees all variable updates for victim's project in real time

### 4.2 Threat: Fake Broadcast Injection

| Attribute | Detail |
|-----------|--------|
| **Threat** | Attacker sends fake `var:update` broadcasts to `entry-sync:{victimProjectId}` |
| **Precondition** | Attacker knows victim's project ID |
| **Difficulty** | Low — anyone with anon key can send to any channel |
| **Impact** | Medium — victim's tabs display incorrect variable values |

**Attack scenario:**
1. Attacker subscribes to `entry-sync:{victimProjectId}` (as above)
2. Attacker sends broadcast: `{ type: 'broadcast', event: 'var:update', payload: { name: 'score', value: '0' } }`
3. Victim's other tabs receive the broadcast and overwrite their local state with the fake value
4. This is a **data pollution attack** — the user's display shows incorrect data

### 4.3 Threat: List Operation Injection

| Attribute | Detail |
|-----------|--------|
| **Threat** | Attacker sends fake `list:update` broadcasts to corrupt list state |
| **Precondition** | Attacker knows victim's project ID |
| **Difficulty** | Low |
| **Impact** | Medium — could inject/remove items from victim's lists |

**Attack scenario:**
1. Attacker sends: `{ type: 'broadcast', event: 'list:update', payload: { name: 'todoItems', operation: 'push', args: [{ id: 'fake', text: 'INJECTED' }] } }`
2. Victim's tabs apply the fake operation to their local list state

### 4.4 Impact Escalation Paths

| Path | Description | Severity |
|------|-------------|----------|
| **Passive sniffing** | Attacker reads variable names/values (information disclosure) | Medium |
| **Active injection** | Attacker corrupts displayed state (data pollution) | Medium |
| **Persistent corruption** | Attacker's injected values get persisted if user saves (but REST RLS would block this) | Low |
| **Denial of service** | Attacker floods channel with messages (rate limiting on server side) | Low |

**Key constraint:** Since the REST API is now protected by RLS (Task T10), injected broadcast values cannot be persisted to the database. The damage is limited to the in-memory state of the current browser session.

---

## 5. Risk Assessment

### 5.1 Risk Matrix

| Risk | Likelihood | Impact | Overall |
|------|-----------|--------|---------|
| Cross-project eavesdropping | Low | Medium | **Low-Medium** |
| Fake broadcast injection | Low | Medium | **Low-Medium** |
| Data persistence corruption | N/A (blocked by REST RLS) | N/A | **None** |

### 5.2 Mitigating Factors

1. **REST API has RLS**: Writes to the database require `x-project-id` header matching the row's `project_id`. Fake broadcast values cannot be persisted.
2. **Ephemeral nature**: Broadcast messages are not stored; they only affect in-memory state in connected tabs.
3. **Project ID is not fully public**: While project IDs appear in URLs, they are 96-bit random hex strings, not sequential integers.
4. **Single-user context**: The extension is designed for personal use, not multi-tenant SaaS.
5. **Channel name scoping**: The `entry-sync:{projectId}` naming convention at least isolates different projects onto different channels (though anyone can join any channel).

### 5.3 Aggravating Factors

1. **Project IDs in URLs**: The project ID is visible in the URL bar (`/project/{id}`), making it trivially extractable.
2. **Anon key is public**: The anon key is hardcoded in the extension and can be extracted from the browser's extension directory or network traffic.
3. **No authentication layer**: The extension has no user auth — all clients share the same anon key identity.
4. **No channel authorization**: No `private: true` flag, no RLS policies on `realtime.messages`.

---

## 6. Mitigation Options

### 6.1 Option A: Channel Name Obfuscation (Recommended for Now)

**Approach:** Replace the plain project ID in the channel name with a salted hash.

```
Before: entry-sync:5e5b055fe282b5008b442394
After:  entry-sync:<sha256(projectId + pepper)>
```

**Pros:**
- No auth/JWT changes needed
- Prevents trivial project ID-based channel joining
- Channel name becomes unguessable without the pepper

**Cons:**
- Security by obscurity — does not prevent a determined attacker from extracting the channel name from network traffic
- Both offscreen and content scripts need the pepper
- Pepper must be consistent across extension instances

**Implementation sketch:**
```typescript
// Shared utility
function getSecureChannelName(projectId: string): string {
  const pepper = 'entry-sync-v1'; // consistent salt
  const hash = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(projectId + pepper));
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `entry-sync:${hashHex}`;
}
```

### 6.2 Option B: Private Channels + Anonymous Auth (Full Solution)

**Approach:** Enable `private: true` on channels and introduce Supabase Anonymous Auth to get a per-user JWT.

**Steps:**
1. Call `supabase.auth.signInAnonymously()` to get a JWT
2. Pass JWT to Realtime client via `realtime.setAuth()`
3. Create channels with `config: { private: true }`
4. Write RLS policy on `realtime.messages` that checks `realtime.topic()` matches via a lookup

**Pros:**
- Proper authorization with Supabase-supported mechanism
- RLS provides real access control, not obscurity

**Cons:**
- Requires code changes to offscreen.ts and realtime-client.ts
- Requires RLS migration on `realtime.messages` table
- Supabase Anonymous Auth consumes Auth MAU quota
- Over-engineered for the current threat model

### 6.3 Option C: Accept as Limitation (Current)

**Approach:** Document the risk and accept it for the current version.

**Rationale:**
- The extension is for personal use — the attacker would need to target a specific user
- Broadcasts are ephemeral and cannot persist corrupted data (REST RLS prevents that)
- Channel name scoping at least segregates by project
- Mitigation can be revisited if the extension gains multi-tenant features

---

## 7. Recommendations

### 7.1 Immediate (No Code Changes)

- [x] **Document this audit** (this file)
- [ ] **Add a security notice** in the extension's README or privacy policy about Realtime broadcast limitations
- [ ] **Monitor** Supabase Realtime authorization features for future improvements

### 7.2 Short-Term (If Risk Is Accepted)

- [ ] **Implement Option A** (channel name obfuscation with salted hash) — raises the bar for casual attackers
- [ ] **No changes to REST RLS** — RLS is already protecting the database

### 7.3 Long-Term (If Multi-Tenant Use Is Planned)

- [ ] **Implement Option B** (private channels + anonymous auth) for proper channel isolation
- [ ] **Add RLS migration** for `realtime.messages` table
- [ ] **Audit** any future Real-time features for security implications

---

## 8. References

- [Supabase Realtime Broadcast Documentation](https://supabase.com/docs/guides/realtime/broadcast)
- [Supabase Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Realtime Broadcast Security Boundary — Anish Gandhi](https://anishgandhi.com/supabase-realtime-broadcast-security-boundary)
- [Supabase Realtime RLS Blog Post](https://supabase.com/blog/realtime-row-level-security-in-postgresql)
- Task T10: `x-project-id` header implementation (docs evidence in `.omo/evidence/`)
- RLS migration: `supabase/rls-migration.sql`

---

## 9. Appendix: Supabase Realtime Authorization Quick Reference

### Enabling Private Channels

```typescript
// Client side
const channel = supabase.channel('entry-sync:projectId', {
  config: { private: true },
});
```

### Required RLS Policies

```sql
-- Allow authenticated users to read broadcasts on their channel
create policy "user can read own broadcasts"
on "realtime"."messages"
for select
to authenticated
using (
  extension = 'broadcast'
  and split_part(topic, ':', 2) = (select auth.uid()::text)
);

-- Allow authenticated users to send broadcasts on their channel
create policy "user can send own broadcasts"
on "realtime"."messages"
for insert
to authenticated
with check (
  extension = 'broadcast'
  and split_part(topic, ':', 2) = (select auth.uid()::text)
);
```

### Key Limitation for This Extension

The Entry Sync extension does not use Supabase Auth at all. The `realtime.topic()` RLS approach works with `auth.uid()`, but the extension has no authenticated users. To use private channels, the extension would need to either:
1. Use Supabase Anonymous Auth to get per-client JWTs
2. Use a custom claim in the JWT (requires custom auth flow)
3. Use request headers (Realtime does not pass custom headers to RLS context)
