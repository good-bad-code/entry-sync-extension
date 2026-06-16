# RLS Rollout Checklist

## Overview

This rollout replaces open "Allow all" RLS policies on `sync_variables` and `sync_lists` with project-scoped policies that authenticate via the `x-project-id` HTTP header. After this change, every Supabase REST call must include a matching `x-project-id` header, or the request returns an empty result set (GET) or a 401/403 error (POST/PATCH/DELETE).

**Status**: Code changes complete. Steps 1 and 2 (SQL migration + curl verification) are PENDING Supabase dashboard access.

### What changed (7 files)

| File | Change |
|------|--------|
| `src/background/background.ts` | `extractProjectId()` regex expanded, `headers()` now sends `x-project-id`, all 7 REST call sites pass `projectId`, empty catch blocks replaced with `console.error`, `INIT_SYNC_RESULT` delivered via `chrome.tabs.sendMessage` |
| `src/content/content.ts` | `extractProjectId()` regex expanded, injection condition now includes `/project/{id}` |
| `src/inject/inject.ts` | Added 3-second stabilization phase after `INIT_SYNC_RESULT`, dedicated `INIT_SYNC_RESULT` handler in `listenForRemoteUpdates` |
| `src/popup/popup.ts` | Added `extractProjectId()`, `POPUP_OPENED` now sends current tab's `projectId` |
| `supabase/rls-migration.sql` | **New** — schema migration + RLS policy creation |
| `test/rls-expected-tests.sh` | **New** — 8 curl acceptance tests (TDD: fail before migration, pass after) |

---

## Prerequisites

- [ ] Supabase dashboard access: [https://supabase.com/dashboard/project/qjjfyuxomsuflczcgktf](https://supabase.com/dashboard/project/qjjfyuxomsuflczcgktf)
- [ ] Chrome extension loaded in developer mode (chrome://extensions), OR Chrome Web Store publisher access
- [ ] `curl` installed (for acceptance tests)
- [ ] `python3` installed (for config parsing in test script)
- [ ] Node.js + npm installed (for webpack build)
- [ ] Project directory: `entry-sync-extension/`

---

## Step 1: Apply SQL Migration

### 1a. Run the migration

Open Supabase SQL Editor and paste the entire contents of `supabase/rls-migration.sql`:

**SQL file**: `/home/mark/entry-sync-extension/supabase/rls-migration.sql`

The migration does 4 things:

1. **Adds `project_id` column** to `sync_variables` and `sync_lists` (safe to run on v1 schema).
2. **Migrates existing data** — extracts project IDs from `project_url` (handles `/iframe/`, `/project/`, `/ws/` URL formats). Unknown formats get `migrated-unknown-{id}`.
3. **Drops old open policies** — `DROP POLICY IF EXISTS "Allow all"` on both tables.
4. **Creates project-scoped RLS policies** using `current_setting('request.headers', true)::json->>'x-project-id'`.

### 1b. Verify the migration

Run these verification queries in Supabase SQL Editor:

```sql
-- Check that policies are in place
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename IN ('sync_variables', 'sync_lists')
ORDER BY tablename, policyname;

-- Check for open policies that should have been dropped
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename IN ('sync_variables', 'sync_lists')
  AND policyname LIKE 'Allow all%';
```

**Expected output for the first query** (after migration):

| schemaname | tablename | policyname | permissive | cmd |
|------------|-----------|------------|------------|-----|
| public | sync_variables | project_scoped_access | PERMISSIVE | ALL |
| public | sync_lists | project_scoped_access | PERMISSIVE | ALL |

The second query should return **0 rows** (all "Allow all" policies removed).

### 1c. Check data migration

```sql
-- Verify project_id values were populated
SELECT COUNT(*) AS total_rows,
       COUNT(project_id) AS with_project_id,
       COUNT(*) - COUNT(project_id) AS missing_project_id
FROM public.sync_variables;

SELECT COUNT(*) AS total_rows,
       COUNT(project_id) AS with_project_id,
       COUNT(*) - COUNT(project_id) AS missing_project_id
FROM public.sync_lists;
```

Both should show `total_rows = with_project_id` and `missing_project_id = 0`.

---

## Step 2: Verify curl Tests

### 2a. Run the acceptance test suite

```bash
cd /home/mark/entry-sync-extension
bash test/rls-expected-tests.sh
```

### 2b. Interpret the results

**Before migration (current state)**:

```
RESULTS: 4 / 8 passed, 4 failed
```

Tests 1, 3, 5, 6 FAIL — this is expected. The open policies allow all access, so:
- Test 1 (GET without header) returns all rows instead of empty array.
- Test 3 (GET with wrong project ID) returns all rows instead of empty array.
- Test 5 (POST mismatched project ID) succeeds (201) instead of being rejected.
- Test 6 (POST without header) succeeds (201) instead of being rejected.

**After migration (target state)**:

```
RESULTS: 8 / 8 passed, 0 failed
```

All 8 tests PASS, confirming that RLS correctly filters by `x-project-id`.

### 2c. Test breakdown

| # | Test | Expected HTTP | Validates |
|---|------|---------------|-----------|
| 1 | GET sync_variables (no x-project-id) | 200 + empty array | RLS filters to `project_id = ''` |
| 2 | GET sync_variables (valid x-project-id) | 200 | Matching rows returned |
| 3 | GET sync_variables (wrong x-project-id) | 200 + empty array | RLS filters non-matching |
| 4 | POST sync_variables (matching) | 201 | WITH CHECK passes |
| 5 | POST sync_variables (mismatched body vs header) | 401 or 403 | WITH CHECK rejects |
| 6 | POST sync_variables (no x-project-id) | 401 or 403 | WITH CHECK rejects |
| 7 | GET sync_lists (no x-project-id) | 200 + empty array | RLS filters to `project_id = ''` |
| 8 | GET sync_lists (valid x-project-id) | 200 | Matching rows returned |

---

## Step 3: Deploy Updated Extension

### 3a. Build the extension

```bash
cd /home/mark/entry-sync-extension
npx webpack --mode production
```

Alternatively: `npm run build`

This compiles 5 webpack entries into `dist/`:
- `dist/background.js` — service worker
- `dist/content.js` — content script
- `dist/inject.js` — injected main-world script
- `dist/offscreen.js` — offscreen document for Realtime
- `dist/popup.js` — popup UI

### 3b. Verify the build includes x-project-id

```bash
# Should show at least 1 match (the header key in headers())
grep -c 'x-project-id' dist/background.js
```

Expected output: `1` (or more, depending on minification).

### 3c. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `dist/` directory

### 3d. Verify extension loads

- The extension card should show "Entry Sync - 실시간 변수 동기화" version 0.1.1.
- No errors in the extension card.
- Open background service worker console (`Inspect views service worker`) and check for console messages.

---

## Step 4: Verify End-to-End

### 4a. Page refresh test

1. Open an Entry project page at `https://playentry.org/project/{id}`.
2. The content script should inject `inject.js` into the MAIN world.
3. The `ENTRY_READY` message should trigger `INIT_SYNC` from content script to background.
4. Background fetches vars/lists from Supabase (with `x-project-id` header) and sends `INIT_SYNC_RESULT`.
5. Inject script applies the values and enters the 3-second stabilization phase.
6. After stabilization, `initialized = true` and user changes are synced to DB.

### 4b. Cross-tab sync test

1. Open the same project in two tabs.
2. Change a `?!` variable in tab A.
3. Tab B should receive the update via Realtime broadcast within ~500ms.

### 4c. Popup isolation test

1. Open the popup on a non-Entry page (e.g., `chrome://extensions`).
2. Popup should show "동기화 중인 변수가 없습니다." (no variables synced).
3. Open the popup on an Entry project page.
4. Popup should show only that project's `?!` variables.

### 4d. Old extension versions

After the RLS migration is applied, **any extension version that does not send the `x-project-id` header will stop working**. Specifically:

- GET requests return empty arrays (all data appears "gone").
- POST/PUT/DELETE requests return 401/403 errors.
- Variables that were previously synced will not load, and new changes will not persist.

Users must update to the new extension version (with `headers()` sending `x-project-id`) for sync to work.

---

## Rollback Procedure

### SQL Rollback

If the RLS migration causes issues, revert the policies and re-create open access.

**Run this in Supabase SQL Editor**:

```sql
-- Drop the new project-scoped policies
DROP POLICY IF EXISTS "project_scoped_access" ON public.sync_variables;
DROP POLICY IF EXISTS "project_scoped_access" ON public.sync_lists;

-- Re-create open "Allow all" policies (original behavior)
CREATE POLICY "Allow all" ON public.sync_variables
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all" ON public.sync_lists
  FOR ALL USING (true) WITH CHECK (true);

-- Verify
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename IN ('sync_variables', 'sync_lists')
ORDER BY tablename, policyname;
```

**Expected output after rollback**:

| schemaname | tablename | policyname |
|------------|-----------|------------|
| public | sync_variables | Allow all |
| public | sync_lists | Allow all |

**Note**: The `project_id` column and migrated data remain after rollback. They are harmless and can be cleaned up later if needed.

### Extension Rollback

1. Rebuild the previous extension version (before RLS changes).
2. In `chrome://extensions`, click **Load unpacked** and select the old `dist/` directory, OR pack the old version as a `.crx` and re-install.
3. The old version works as before, since rollback SQL restored open policies.

### Rollback Order

1. **First** roll back the extension (reload old version or use the old build).
2. **Then** roll back the SQL (restore open policies).

This order prevents a window where the new extension sends `x-project-id` but the old open policies accept everything anyway (which is fine functionally, but consistent ordering is good practice).

---

## Monitoring

### Supabase Dashboard Logs

1. Navigate to **Logs > Postgres Logs** in the Supabase dashboard: [https://supabase.com/dashboard/project/qjjfyuxomsuflczcgktf/logs/postgres-logs](https://supabase.com/dashboard/project/qjjfyuxomsuflczcgktf/logs/postgres-logs)
2. Filter by `duration` to watch for performance changes.
3. Filter by `error` to catch any RLS-related query rejections.

### Key metrics to watch

| Metric | What to look for | Action if abnormal |
|--------|------------------|-------------------|
| 401/403 errors | Spike after deployment | Check if old extension versions are still in use; remind users to update |
| Query duration | Significant increase (>2x baseline) | Verify the policy is using the index on `project_id` |
| Connection count | No unusual change expected | N/A |

### Log queries to run

In Supabase SQL Editor, check for rejected queries:

```sql
-- Count queries filtered by RLS (these are normal, but spikes may indicate issues)
SELECT count(*) FROM pg_stat_statements
WHERE query LIKE '%sync_variables%' OR query LIKE '%sync_lists%';
```

### Chrome extension monitoring

1. Open the background service worker console (`chrome://extensions` -> "Entry Sync" -> `Inspect views service worker`).
2. Look for `upsertVar FAIL` or `fetchVars FAIL` log messages with HTTP 4xx status codes.
3. The dbLog entries show which REST calls are failing and their HTTP status codes.

---

## Expected Behavior Changes

### For end users

| Behavior | Before RLS | After RLS |
|----------|-----------|-----------|
| Sync variables between tabs | Works | Works (same) |
| Popup shows variables | All projects' variables | Only current tab's project variables |
| Non-Entry page popup | Shows all data | Shows "No variables synced" |
| `extractProjectId` regex | `/project\|ws\|iframe` only | `/project\|ws\|iframe\|embed\|e\|play\|p` |
| Content injection on `/project/{id}` | MISSING (bug) | Now works |
| INIT_SYNC_RESULT delivery | `chrome.runtime.sendMessage` | `chrome.tabs.sendMessage` (targeted to originating tab) |
| Inject stabilization phase | None | 3-second phase after INIT_SYNC_RESULT prevents Entry init overwrites |
| Extension builds without `x-project-id` | Works (open RLS) | **Fails** (401/403 on all requests) |

### For extension developers

| Aspect | Before | After |
|--------|--------|-------|
| `headers()` signature | `headers()` | `headers(projectId?: string)` |
| All REST call sites pass projectId | No | Yes (7 call sites updated) |
| Empty catch blocks | Silent failure | `console.error` logged |
| Popup `POPUP_OPENED` | No projectId sent | Sends `{ projectId }` from active tab |
| curl acceptance tests | None | 8 tests in `test/rls-expected-tests.sh` |

### SQL impact

| Aspect | Before | After |
|--------|--------|-------|
| RLS policy | Open (`USING true`) | Project-scoped (`USING project_id = current_setting('request.headers', true)::json->>'x-project-id'`) |
| Auth mechanism | None | `x-project-id` HTTP header |
| Plan compatibility | All plans | All plans (uses `current_setting`, no `pgrst.db_pre_request` needed) |
| Schema version | v1 (project_url) or v2 (project_id) | v2 only (migration auto-adds project_id if missing) |

---

## Verification Checklist (final)

- [ ] Step 1: SQL migration applied in Supabase dashboard
- [ ] Step 1b: `SELECT * FROM pg_policies` shows `project_scoped_access` policies
- [ ] Step 1c: `COUNT(project_id)` equals `COUNT(*)` for both tables
- [ ] Step 2: `bash test/rls-expected-tests.sh` shows 8/8 passed
- [ ] Step 3a: `npx webpack --mode production` succeeds with no errors
- [ ] Step 3b: `grep -c 'x-project-id' dist/background.js` >= 1
- [ ] Step 3c: Extension loads in chrome://extensions without errors
- [ ] Step 4a: Page refresh — variables sync correctly
- [ ] Step 4b: Cross-tab sync — changes propagate between tabs
- [ ] Step 4c: Popup isolation — shows only current tab's variables
- [ ] Rollback SQL syntax verified (DROP + CREATE)
