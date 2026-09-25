"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { FilterResult } from "@/features/flip-finder/results";
import type { CanonicalDeal, DealFactOverrides } from "../types";
import { InvestmentDealNotComputedError, loadInvestmentDeal, type DealWithMedia } from "../investment-client";
import { CeoCommandCenter } from "./ceo-command-center";
import { DealHealth } from "./deal-health";
import { DirectorBoard } from "./director-board";
import { DecisionWorkspace } from "./decision-workspace";
import { type WorkspaceTab } from "./workspace-tabs";
import { OverridePanel } from "./override-panel";
import { DealRoomView } from "./deal-room-view";

export function InvestmentDesk({ result, room = false }: { result: Pick<FilterResult, "id">; room?: boolean }) {
  const [deal, setDeal] = useState<CanonicalDeal | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notComputed, setNotComputed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const initializationInFlight = useRef(false);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>("OVERVIEW");

  const load = useCallback(async () => {
    setError(null);
    setNotComputed(false);
    try {
      const loaded = await loadInvestmentDeal(result.id);
      setDeal(loaded);
      setImages((loaded as DealWithMedia).media ?? []);
    } catch (cause) {
      setDeal(null);
      if (cause instanceof InvestmentDealNotComputedError) {
        setNotComputed(true);
      } else {
        setError(cause instanceof Error ? cause.message : "Analiza inwestycyjna jest niedostępna");
      }
    } finally {
      setLoading(false);
    }
  }, [result.id]);

  const initialize = async () => {
    if (!notComputed || initializationInFlight.current) return;
    initializationInFlight.current = true;
    setInitializing(true);
    setInitializationError(null);
    let initializeSucceeded = false;

    try {
      const response = await fetch(`/api/flip-finder/listings/${result.id}/investment/initialize`, {
        method: "POST",
      });
      const body = await response.json().catch(() => null) as { deal?: CanonicalDeal; message?: string } | null;
      if (!response.ok || !body?.deal) {
        throw new Error(body?.message || "Nie udało się przygotować analizy.");
      }
      initializeSucceeded = true;

      // Render only the canonical read model; the POST response is not the UI's source of truth.
      const loaded = await loadInvestmentDeal(result.id);
      setDeal(loaded);
      setImages((loaded as DealWithMedia).media ?? []);
      setNotComputed(false);
      setError(null);
    } catch {
      setInitializationError(initializeSucceeded
        ? "Analiza została przygotowana, ale nie udało się jej wczytać. Spróbuj ponownie."
        : "Nie udało się przygotować analizy. Możesz spróbować ponownie.");
    } finally {
      initializationInFlight.current = false;
      setInitializing(false);
    }
  };

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
        headers: { "content-type": "application/json" },
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
    if (notComputed) {
      return (
        <section className="ui-empty-state px-5 py-8 text-left sm:px-8" data-investment-initialize-state role="region" aria-labelledby="investment-initialize-title">
          <div className="w-full max-w-xl space-y-4">
            <div>
              <p className="type-badge uppercase text-gold">Pokój transakcji</p>
              <h2 className="type-section-title mt-2" id="investment-initialize-title">Analiza nie została jeszcze przygotowana</h2>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              Dla tej oferty nie ma jeszcze zapisanej analizy inwestycyjnej. Przygotujemy ją dopiero po Twoim poleceniu.
            </p>
            {initializing ? <div className="rounded-xl border border-gold/20 bg-gold/[0.05] px-4 py-3" aria-live="polite" role="status">
              <p className="text-sm font-semibold text-gold">PRZYGOTOWUJĘ ANALIZĘ</p>
              <p className="mt-1 text-sm text-muted-foreground">Zespół inwestycyjny analizuje ofertę. To może chwilę potrwać.</p>
            </div> : null}
            {initializationError ? <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">{initializationError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-gold/50 bg-gold px-5 text-sm font-semibold text-[#17140c] shadow-[0_12px_30px_-18px_rgba(214,179,90,.85)] outline-none transition hover:bg-gold/90 focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-wait disabled:opacity-65"
                data-initialize-deal
                disabled={initializing}
                onClick={() => void initialize()}
                type="button"
              >
                {initializing ? "PRZYGOTOWUJĘ ANALIZĘ" : initializationError ? "SPRÓBUJ PONOWNIE" : "PRZYGOTUJ ANALIZĘ"}
              </button>
              <Link className="inline-flex min-h-10 items-center rounded-xl border border-border px-4 text-sm font-semibold text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/flip-finder">
                Wróć do Flip Findera
              </Link>
            </div>
          </div>
        </section>
      );
    }
    return (
      <div className="space-y-4 px-4 py-5 sm:px-7 sm:py-7" role="status">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Centrum decyzji inwestycyjnej</p>
          <h2 className="mt-1 text-xl font-semibold">Analiza niedostępna</h2>
        </header>
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error ?? "Nie udało się wczytać analizy tej oferty."}
          <button className="ml-3 rounded-md underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setLoading(true); void load(); }} type="button">Spróbuj ponownie</button>
        </div>
      </div>
    );
  }

  if (room) return <DealRoomView deal={deal} images={images} onRefresh={() => { setLoading(true); void load(); }} onSave={save} saving={saving} />;
  const ceo = deal.ceo.result;
  return (
    <div className="min-w-0 max-w-full space-y-5 px-4 py-5 sm:px-7 sm:py-7">
      <CeoCommandCenter deal={deal} onOpenPlaybook={() => setActiveWorkspaceTab("PLAYBOOK")} />
      <DealHealth deal={deal} />
      <div className="flex justify-end"><Link className="inline-flex min-h-9 items-center rounded-xl border border-border px-3 text-xs font-semibold text-foreground outline-none transition hover:border-gold/25 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" href={`/deals/${encodeURIComponent(result.id)}`}>Otwórz pokój transakcji</Link></div>
      <DirectorBoard deal={deal} />
      <DecisionWorkspace deal={deal} activeTab={activeWorkspaceTab} onTabChange={setActiveWorkspaceTab} />
      <OverridePanel deal={deal} disabled={saving} onSave={save} />
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
      <p className="text-xs text-muted-foreground">Poziom analizy: <strong className="font-medium text-foreground">{deal.analysisLevel}</strong> · dowody: <strong className="font-medium text-foreground">{deal.evidenceFabric.length}</strong>{ceo?.deepDiveRecommended ? ` · pogłębiona analiza: ${ceo.deepDiveReason ?? "zalecana"}` : ""}</p>
    </div>
  );
}

function InvestmentDeskSkeleton() {
  return (
    <div aria-label="Wczytywanie analizy inwestycyjnej" className="space-y-4 px-4 py-5 sm:px-7 sm:py-7" role="status">
      <div className="h-56 animate-pulse rounded-2xl bg-muted sm:h-52" />
      <div className="grid gap-3 sm:grid-cols-3"><div className="h-24 animate-pulse rounded-xl bg-muted" /><div className="h-24 animate-pulse rounded-xl bg-muted" /><div className="h-24 animate-pulse rounded-xl bg-muted" /></div>
      <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      <span className="sr-only">Trwa wczytywanie analizy inwestycyjnej.</span>
    </div>
  );
}
