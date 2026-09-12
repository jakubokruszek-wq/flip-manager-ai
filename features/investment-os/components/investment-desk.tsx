"use client";

import { useCallback, useEffect, useState } from "react";
import type { FilterResult } from "@/features/flip-finder/results";
import type { CanonicalDeal, DealFactOverrides } from "../types";
import { loadInvestmentDeal } from "../investment-client";
import { CeoCommandCenter } from "./ceo-command-center";
import { DealHealth } from "./deal-health";
import { DirectorBoard } from "./director-board";
import { DecisionWorkspace } from "./decision-workspace";
import { type WorkspaceTab } from "./workspace-tabs";
import { OverridePanel } from "./override-panel";

export function InvestmentDesk({ result }: { result: FilterResult }) {
  const [deal, setDeal] = useState<CanonicalDeal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>("OVERVIEW");

  const load = useCallback(async () => {
    setError(null);
    try {
      setDeal(await loadInvestmentDeal(result.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investment Desk niedostępny");
    } finally {
      setLoading(false);
    }
  }, [result.id]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const save = async (overrides: DealFactOverrides) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/flip-finder/listings/${result.id}/investment`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-flip-finder-action": "investment-os" },
        body: JSON.stringify({ overrides }),
      });
      const body = await response.json();
      if (!response.ok || !body.deal) throw new Error(body.message ?? "Nie udało się zapisać");
      setDeal(body.deal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zapisać");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <InvestmentDeskSkeleton />;
  if (!deal) {
    return (
      <div className="space-y-4 px-4 py-5 sm:px-7 sm:py-7" role="status">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Investment Command Center</p>
          <h2 className="mt-1 text-xl font-semibold">Analiza niedostępna</h2>
        </header>
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error ?? "Nie udało się wczytać analizy tej oferty."}
          <button className="ml-3 rounded-md underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setLoading(true); void load(); }} type="button">Spróbuj ponownie</button>
        </div>
      </div>
    );
  }

  const ceo = deal.ceo.result;
  return (
    <div className="min-w-0 max-w-full space-y-5 px-4 py-5 sm:px-7 sm:py-7">
      <CeoCommandCenter deal={deal} onOpenPlaybook={() => setActiveWorkspaceTab("PLAYBOOK")} />
      <DealHealth deal={deal} />
      <DirectorBoard deal={deal} />
      <DecisionWorkspace deal={deal} activeTab={activeWorkspaceTab} onTabChange={setActiveWorkspaceTab} />
      <OverridePanel deal={deal} disabled={saving} onSave={save} />
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
      <p className="text-xs text-muted-foreground">Poziom analizy: <strong className="font-medium text-foreground">{deal.analysisLevel}</strong> · evidence items: <strong className="font-medium text-foreground">{deal.evidenceFabric.length}</strong>{ceo?.deepDiveRecommended ? ` · deep dive: ${ceo.deepDiveReason ?? "zalecany"}` : ""}</p>
    </div>
  );
}

function InvestmentDeskSkeleton() {
  return (
    <div aria-label="Wczytywanie Investment Command Center" className="space-y-4 px-4 py-5 sm:px-7 sm:py-7" role="status">
      <div className="h-56 animate-pulse rounded-2xl bg-muted sm:h-52" />
      <div className="grid gap-3 sm:grid-cols-3"><div className="h-24 animate-pulse rounded-xl bg-muted" /><div className="h-24 animate-pulse rounded-xl bg-muted" /><div className="h-24 animate-pulse rounded-xl bg-muted" /></div>
      <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      <span className="sr-only">Trwa wczytywanie analizy inwestycyjnej.</span>
    </div>
  );
}
