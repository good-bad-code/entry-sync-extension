// ========================================
// chrome.storage Wrapper (minimal — no config storage)
// ========================================

// Per-project sync variable cache (ephemeral, session storage)
export async function getProjectVars(projectUrl: string): Promise<Record<string, string | number> | null> {
  const result = await chrome.storage.session.get(projectUrl);
  return (result[projectUrl] as Record<string, string | number>) || null;
}

export async function saveProjectVars(projectUrl: string, vars: Record<string, string | number>): Promise<void> {
  await chrome.storage.session.set({ [projectUrl]: vars });
}
