import type { KeyboardEvent } from "react";
import type { CanonicalDeal } from "../types";
import { SectionHeading } from "./investment-ui";
import { AuditPanel } from "./audit-panel";
import { EconomicsPanel } from "./economics-panel";
import { MarketPanel } from "./market-panel";
import { OverviewPanel } from "./overview-panel";
import { PlaybookPanel } from "./playbook-panel";
import { RisksPanel } from "./risks-panel";
import { nextWorkspaceTab, WORKSPACE_TABS, type WorkspaceTab } from "./workspace-tabs";

const TAB_LABELS: Record<WorkspaceTab, string> = {
  OVERVIEW: "Overview", MARKET: "Market", ECONOMICS: "Economics", RISKS: "Risks", PLAYBOOK: "Playbook", AUDIT: "Audit",
};

export function DecisionWorkspace({ deal, activeTab, onTabChange }: { deal: CanonicalDeal; activeTab: WorkspaceTab; onTabChange: (tab: WorkspaceTab) => void }) {
  const prefix = `workspace-${deal.id}`;
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focusedTab = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[role='tab']")?.dataset.workspaceTab as WorkspaceTab | undefined : undefined;
    const next = nextWorkspaceTab(focusedTab ?? activeTab, event.key);
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    document.getElementById(`${prefix}-tab-${next}`)?.focus();
  };

  return <section aria-labelledby={`${prefix}-heading`} className="min-w-0 max-w-full space-y-3">
    <SectionHeading eyebrow="04 · decision workspace" id={`${prefix}-heading`} title="Deal workspace" />
    <div aria-label="Sekcje analizy deala" className="flex gap-1 overflow-x-auto rounded-xl border border-border/70 bg-muted/35 p-1" onKeyDown={onTabKeyDown} role="tablist">
      {WORKSPACE_TABS.map((tab) => <button aria-controls={`${prefix}-panel`} aria-selected={activeTab === tab} className={`min-h-10 shrink-0 rounded-lg px-3 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${activeTab === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`} data-workspace-tab={tab} id={`${prefix}-tab-${tab}`} key={tab} onClick={() => onTabChange(tab)} role="tab" tabIndex={activeTab === tab ? 0 : -1} type="button">{TAB_LABELS[tab]}</button>)}
    </div>
    <div aria-labelledby={`${prefix}-tab-${activeTab}`} className="min-h-40 rounded-xl border border-border/70 bg-muted/10 p-3 sm:p-4" id={`${prefix}-panel`} role="tabpanel" tabIndex={0}>
      {activeTab === "OVERVIEW" ? <OverviewPanel deal={deal} /> : null}
      {activeTab === "MARKET" ? <MarketPanel deal={deal} /> : null}
      {activeTab === "ECONOMICS" ? <EconomicsPanel deal={deal} /> : null}
      {activeTab === "RISKS" ? <RisksPanel deal={deal} /> : null}
      {activeTab === "PLAYBOOK" ? <PlaybookPanel playbook={deal.playbook} /> : null}
      {activeTab === "AUDIT" ? <AuditPanel deal={deal} /> : null}
    </div>
  </section>;
}
