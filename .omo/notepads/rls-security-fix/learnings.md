
## Task 3: Baseline (RED phase) — Vulnerability Confirmed

### Date
2026-06-16

### Script
`test/rls-baseline-tests.sh` — curl-based TDD baseline test

### Key Findings
- **All 5 tests PASS** — confirming RLS is completely open (`USING(true) WITH CHECK(true)`)
- **474 rows** from `sync_variables` returned without any filter (any anon key holder sees ALL data)
- **1000+ rows** from `sync_lists` returned without any filter
- **INSERT succeeds** (HTTP 201) for any project_url
- **Cleanup succeeds** (HTTP 204) — test data was removable

### Database Schema (actual, v1)
The database has NOT been migrated to v2 yet:
- Column is `project_url` (TEXT), NOT `project_id`
- Unique constraint is on `(project_url, name)`
- Tables: `sync_variables` (id UUID, project_url TEXT, name TEXT, value TEXT, updated_at TIMESTAMPTZ)
- Tables: `sync_lists` (id UUID, project_url TEXT, name TEXT, value JSONB, updated_at TIMESTAMPTZ)

### Vulnerability
Any client with the **anon key** (public by design in Supabase) can:
1. Read ALL rows from both tables
2. Write rows for ANY project_url
3. Delete rows for ANY project_url

This is the baseline that RLS policies must fix.

### Evidence File
`.omo/evidence/task-3-baseline-output.txt` — full test run output

---

## Task 14: INIT_SYNC_RESULT Delivery Fix

### Date
2026-06-16

### Bug A: `chrome.runtime.sendMessage` → `chrome.tabs.sendMessage`
- **Root cause**: `INIT_SYNC_RESULT` was sent via `chrome.runtime.sendMessage` which broadcasts to ALL extension contexts. Content scripts may miss this message if they haven't fully initialized.
- **Fix**: Capture `sender.tab?.id` from the onMessage listener's `sender` parameter, then use `chrome.tabs.sendMessage(tabId, ...)` for direct delivery to the tab's content script. Kept `chrome.runtime.sendMessage` as fallback when `tabId` is unavailable.
- **Files**: `src/background/background.ts:318-332`

### Bug B: `processPendingUpdates` missing `initialized = true`
- **Root cause**: The `processPendingUpdates` function's `INIT_SYNC_RESULT` handler applied DB values to Entry variables but never set `initialized = true`. This caused subsequent `setValue` calls to be permanently blocked (the guard at line 148 checks `!initialized`).
- **Note**: The `listenForRemoteUpdates` handler already had this fix (line 470), but `processPendingUpdates` (which handles queued updates arriving before the listener was attached) was missing it.
- **Fix**: Added `initialized = true` to the finally block at line 352.
- **Files**: `src/inject/inject.ts:352`

### Evidence Files
- `.omo/evidence/task-14-tabs-sendmessage.txt`
- `.omo/evidence/task-14-build.log`

### Build Status
- `npx webpack --mode production`: SUCCESS (compiled in ~8-10s)
- `dist/background.js` confirmed to contain `chrome.tabs.sendMessage` for INIT_SYNC_RESULT with fallback
