-- Entry Sync Extension - Backfill project_id for RLS Compatibility
-- =============================================================
-- Run this AFTER STEP 1 (ADD COLUMN) and STEP 3+4 (RLS policies) are applied.
-- This script ONLY backfills project_id — it does NOT modify schema or policies.
--
-- STEP ORDER:
--   A) Run PRE-FLIGHT queries to inspect existing data
--   B) Run UPDATE statements to backfill project_id
--   C) Run POST-FLIGHT queries to verify
--
-- Covers ALL 7 URL prefixes from extractProjectId() regex in background.ts:
--   project, ws, iframe, embed, e, play, p
-- =============================================================

-- =============================================================
-- PRE-FLIGHT: How many rows need project_id backfilled?
-- =============================================================
SELECT COUNT(*) AS null_count FROM public.sync_variables WHERE project_id IS NULL;
SELECT COUNT(*) AS null_count FROM public.sync_lists WHERE project_id IS NULL;

-- What distinct URL patterns exist in NULL project_id rows?
SELECT DISTINCT SPLIT_PART(project_url, '/', 3) AS url_part
FROM public.sync_variables WHERE project_id IS NULL AND project_url IS NOT NULL;

-- Any rows with both project_url AND project_id NULL? (unrecoverable)
SELECT COUNT(*) AS null_url FROM public.sync_variables WHERE project_url IS NULL AND project_id IS NULL;
SELECT COUNT(*) AS null_url FROM public.sync_lists WHERE project_url IS NULL AND project_id IS NULL;

-- Show sample rows with NULL project_id (first 20 per table)
SELECT id, project_url, name FROM public.sync_variables WHERE project_id IS NULL LIMIT 20;
SELECT id, project_url, name FROM public.sync_lists WHERE project_id IS NULL LIMIT 20;

-- =============================================================
-- BACKFILL: Extract project_id from project_url for each URL prefix
-- =============================================================
-- Note: Uses LIKE pattern matching to identify URL format,
-- then SPLIT_PART to extract the project ID segment.
-- The '?query' suffix is stripped via second SPLIT_PART.

-- =============================================================
-- public.sync_variables
-- =============================================================

-- project prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/project/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/project/%';

-- ws prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/ws/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/ws/%';

-- iframe prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/iframe/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/iframe/%';

-- embed prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/embed/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/embed/%';

-- e prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/e/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/e/%';

-- play prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/play/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/play/%';

-- p prefix
UPDATE public.sync_variables SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/p/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/p/%';

-- =============================================================
-- public.sync_lists
-- =============================================================

-- project prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/project/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/project/%';

-- ws prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/ws/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/ws/%';

-- iframe prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/iframe/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/iframe/%';

-- embed prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/embed/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/embed/%';

-- e prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/e/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/e/%';

-- play prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/play/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/play/%';

-- p prefix
UPDATE public.sync_lists SET project_id = SPLIT_PART(SPLIT_PART(project_url, '/p/', 2), '?', 1)
WHERE project_id IS NULL AND project_url LIKE '%/p/%';

-- =============================================================
-- POST-FLIGHT: Verify backfill completed successfully
-- =============================================================
-- Remaining NULLs should be 0 if all prefixes were covered
SELECT COUNT(*) AS remaining_null FROM public.sync_variables WHERE project_id IS NULL;
SELECT COUNT(*) AS remaining_null FROM public.sync_lists WHERE project_id IS NULL;

-- If any NULLs remain, show them (likely unknown URL format or NULL project_url)
SELECT id, project_url, name FROM public.sync_variables WHERE project_id IS NULL;
SELECT id, project_url, name FROM public.sync_lists WHERE project_id IS NULL;
