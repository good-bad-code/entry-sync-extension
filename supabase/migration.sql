-- Entry Sync Extension - Supabase Migration
-- Run this in your Supabase project SQL editor

-- 1. Create sync_variables table
CREATE TABLE IF NOT EXISTS public.sync_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_url TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_url, name)
);

-- 2. Create sync_lists table
CREATE TABLE IF NOT EXISTS public.sync_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_url TEXT NOT NULL,
  name TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_url, name)
);

-- 3. Create indexes
CREATE INDEX IF NOT EXISTS idx_sync_variables_project ON public.sync_variables(project_url);
CREATE INDEX IF NOT EXISTS idx_sync_lists_project ON public.sync_lists(project_url);

-- 4. Enable Row Level Security
ALTER TABLE public.sync_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_lists ENABLE ROW LEVEL SECURITY;

-- 5. Allow public access (extension uses anon key)
CREATE POLICY "Allow all on sync_variables"
  ON public.sync_variables FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on sync_lists"
  ON public.sync_lists FOR ALL
  USING (true) WITH CHECK (true);

-- 6. Realtime Broadcast: On in project settings (no CDC needed)
