export const WORKSPACE_TABS = ["OVERVIEW", "MARKET", "ECONOMICS", "RISKS", "PLAYBOOK", "AUDIT"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function nextWorkspaceTab(current: WorkspaceTab, key: string): WorkspaceTab | null {
  const index = WORKSPACE_TABS.indexOf(current);
  if (key === "Home") return WORKSPACE_TABS[0];
  if (key === "End") return WORKSPACE_TABS[WORKSPACE_TABS.length - 1];
  if (key === "ArrowRight" || key === "ArrowDown") return WORKSPACE_TABS[(index + 1) % WORKSPACE_TABS.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return WORKSPACE_TABS[(index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length];
  return null;
}
