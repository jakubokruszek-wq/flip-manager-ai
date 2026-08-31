"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

import {
  canRunManualScan,
  retryCollectorReadiness,
  summarizeStartTrace,
  dashboardCount,
  filterResultsHref,
  hasLatestScan,
  latestScanCounters,
  NO_SCANS_MESSAGE,
  scanStatusLabel,
} from "@/features/flip-finder/dashboard";
import { OTODOM_AUTOMATION_BLOCKED_MESSAGE } from "@/features/flip-finder/otodom-search-response";
import type {
  SearchFilterListItem,
  SearchFilterListResponse,
  SearchFilterScan,
} from "@/features/flip-finder/search-filter-contract";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InlineFilterResults } from "@/features/flip-finder/components/inline-filter-results";
import { ScanProgressPanel, VisionCostPanel } from "@/features/flip-finder/components/scan-progress-panel";
import { hasActiveBackendWork, hasQueuedOrRunningFacebookWork, isTerminalScanStatus, type ScanProgressResponse } from "@/features/flip-finder/scan-progress";

type ScanResponse = {
  runId?: string;
  status?: "running" | "completed" | "partial";
  scannedCount: number;
  matchedCount: number;
  newCount: number;
  updatedCount: number;
  priceDropCount: number;
  matchDiagnostics?: MatchDiagnostics;
  sourceResults?: Array<{
    source: string;
    status: "pending" | "completed" | "failed";
    fetched?: number;
    matched?: number;
    errorMessage: string | null;
    matchDiagnostics?: MatchDiagnostics;
  }>;
};

type MatchDiagnostics = {
  rejectedByPrice: number;
  rejectedByPricePerSqm: number;
  rejectedByRooms: number;
  rejectedByDistrict: number;
  rejectedByArea: number;
  rejectedByBuildingType: number;
  matched: number;
};

export function FlipFinderPage() {
  const [requestedFilterId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("activeFilter"));
  const [data, setData] = useState<SearchFilterListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryFilterId, setRetryFilterId] = useState<string | null>(null);
  const [scanningFilterIds, setScanningFilterIds] = useState<Set<string>>(new Set());
  const [resultsRevision, setResultsRevision] = useState(0);
  const [lastScanDiagnostics, setLastScanDiagnostics] = useState<{ filter: SearchFilterListItem; response: ScanResponse } | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressResponse | null>(null);
  const [activeScanRunId, setActiveScanRunId] = useState<string | null>(null);
  const [startTrace, setStartTrace] = useState<StartTrace | null>(null);
  const [showStartTrace, setShowStartTrace] = useState(false);
  const scanningFilterIdsRef = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/flip-finder/search-filters", { cache: "no-store" });
      const payload: unknown = await readJson(response);

      if (!response.ok || !isSearchFilterListResponse(payload)) {
        throw new Error(readMessage(payload, "Nie udało się pobrać danych Flip Findera."));
      }

      setData(payload);
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Nie udało się pobrać danych Flip Findera.",
      );
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const filter = data.filters.find((item) => item.id === requestedFilterId) ?? data.filters.find((item) => item.isActive) ?? data.filters[0];
    const runId = filter?.lastScan?.scanRunId;
    if (!filter || !runId || scanningFilterIdsRef.current.has(filter.id)) return;
    let cancelled = false;
    const refresh = async () => {
      while (!cancelled) {
        const progress = await fetchScanProgress(runId).catch(() => null);
        if (!progress || cancelled) return;
        setScanProgress(progress);
        setActiveScanRunId((current) => current ?? runId);
        if (isTerminalScanStatus(progress.status)) return;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    };
    void refresh();
    return () => { cancelled = true; };
  }, [data, requestedFilterId]);

  const scanFilter = async (filter: SearchFilterListItem) => {
    if (
      !canRunManualScan(filter.isActive, scanningFilterIdsRef.current.has(filter.id)) ||
      scanningFilterIdsRef.current.has(filter.id)
    ) {
      return;
    }

    scanningFilterIdsRef.current.add(filter.id);
    setScanningFilterIds((current) => new Set(current).add(filter.id));
    setError(null);
    setNotice(filter.sources.includes("facebook") ? "Łączenie z Flip Collectorem..." : null);
    setRetryFilterId(null);
    setActiveScanRunId(null);
    setScanProgress(null);
    const requestId = crypto.randomUUID();
    traceStage(requestId, "BUTTON_CLICKED", "PASS");

    let waitingForWorker = false;
    try {
      const usesFacebookCollector = filter.sources.includes("facebook");
      if (usesFacebookCollector) {
        const bridge = await requestCollectorBridgePing(requestId);
        if (!bridge.ok) throw new Error("Nie wykryto aktywnego bridge Flip Collectora. Odśwież stronę i spróbuj ponownie.");
        let readinessAttempt = 0;
        const readiness = await retryCollectorReadiness(() => requestCollectorReady(requestId, ++readinessAttempt), (attempt) => {
          if (attempt > 1) setNotice("Ponawianie połączenia z Collectorem...");
        });
        if (!readiness.ok) throw new Error("Nie udało się połączyć z Flip Collectorem. Otwórz rozszerzenie i sprawdź status Połączono.");
        setNotice("Collector połączony — uruchamiam skan...");
      }
      traceStage(requestId, "POST_SCAN_SENT", "PASS");
      const response = await fetch(`/api/flip-finder/search-filters/${filter.id}/scan`, {
        method: "POST",
      });
      traceStage(requestId, "POST_SCAN_RESPONSE", response.ok ? "PASS" : "FAIL", response.ok ? undefined : `HTTP_${response.status}`);
      const payload: unknown = await readJson(response);

      if (response.status === 429) {
        throw new Error("Skan tego filtra już trwa.");
      }

      if (!response.ok || !isScanResponse(payload)) {
        throw new Error(scanErrorMessage(response.status, payload));
      }

      setLastScanDiagnostics({ filter, response: payload });
      let initialProgress: ScanProgressResponse | null = null;
      if (payload.runId) {
        traceStage(requestId, "NEW_SCAN_RUN_ID", "PASS");
        setActiveScanRunId(payload.runId);
        initialProgress = await fetchScanProgress(payload.runId).catch(() => null);
        if (initialProgress) setScanProgress(initialProgress);
      }

      if (payload.status === "running" && payload.runId) {
        if (initialProgress && !hasActiveBackendWork(initialProgress)) {
          setNotice(`Skan zakończony. Znaleziono ${formatNumber(initialProgress.totals.matched)} dopasowań.`);
          await load();
          setResultsRevision((current) => current + 1);
          return;
        }
        waitingForWorker = true;
        if (usesFacebookCollector) {
          traceStage(requestId, "SCAN_COMMAND_SENT", "PASS");
          const dispatch = await requestCollectorScan(payload.runId, requestId);
          if (!dispatch.ok || dispatch.accepted !== true) {
            waitingForWorker = false;
            await fetch(`/api/flip-finder/scans/${payload.runId}/cancel`, { method: "POST" }).catch(() => {});
            throw new Error(dispatch.error || "Collector nie przyjął zadania skanu.");
          }
          setNotice("Facebook: uruchomiono production Collector.");
        } else if (initialProgress && hasQueuedOrRunningFacebookWork(initialProgress)) {
          setNotice("Facebook: oczekuje na lokalny worker. Pozostałe źródła zakończyły swój bieżący przebieg.");
        }
        void monitorScanRun(filter.id, payload.runId);
        await load();
        setResultsRevision((current) => current + 1);
        return;
      }

      if (payload.status === "partial") {
        const failures = payload.sourceResults?.filter((result) => result.status === "failed") ?? [];
        if (failures.length) {
          setNotice(`Skan zakończył się częściowo. Zapisano oferty z działających źródeł. Błąd: ${failures.map((result) => `${result.source}${result.errorMessage ? ` — ${result.errorMessage}` : ""}`).join("; ")}`);
        } else {
        setNotice("Skan zakończył się częściowo. Część ofert została zapisana.");
        }
      } else {
        setNotice(
          `Skan zakończony. Znaleziono ${formatNumber(payload.newCount)} nowych dopasowań ` +
            `(${formatNumber(payload.scannedCount)} sprawdzonych, ` +
            `${formatNumber(payload.updatedCount)} zaktualizowanych, ` +
            `${formatNumber(payload.priceDropCount)} obniżek).`,
        );
      }

      await load();
      setResultsRevision((current) => current + 1);
    } catch (reason) {
      const scanMessage = reason instanceof Error ? reason.message : "";
      traceStage(requestId, "START_FAILED", "FAIL", safeTraceError(scanMessage));
      setStartTrace(readStartTrace());
      setRetryFilterId(
        scanMessage === OTODOM_AUTOMATION_BLOCKED_MESSAGE ? filter.id : null,
      );
      setError(reason instanceof Error ? reason.message : "Nie udało się wykonać skanu.");
    } finally {
      if (!waitingForWorker) finishScanning(filter.id);
    }
  };

  const finishScanning = (filterId: string) => {
    scanningFilterIdsRef.current.delete(filterId);
    setScanningFilterIds((current) => {
      const next = new Set(current);
      next.delete(filterId);
      return next;
    });
  };

  const stopScan = async (filter: SearchFilterListItem) => {
    const runId = activeScanRunId;
    if (!runId || !scanningFilterIdsRef.current.has(filter.id)) return;
    setNotice("Zatrzymywanie…");
    try {
      const response = await fetch(`/api/flip-finder/scans/${runId}/cancel`, { method: "POST" });
      const payload: unknown = await readJson(response);
      if (!response.ok) throw new Error(readMessage(payload, "Nie udało się zatrzymać skanu."));
      setNotice("Zatrzymano");
      finishScanning(filter.id);
      const progress = await fetchScanProgress(runId).catch(() => null);
      if (progress) setScanProgress(progress);
      await load();
      setResultsRevision((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się zatrzymać skanu.");
    }
  };

  const monitorScanRun = async (filterId: string, runId: string) => {
    let consecutiveFailures = 0;
    let firstPoll = true;
    try {
      while (scanningFilterIdsRef.current.has(filterId)) {
        if (!firstPoll) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        firstPoll = false;
        const payload = await fetchScanProgress(runId).catch(() => null);
        if (!payload) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            setError("Nie udało się odczytać postępu skanu. Stan skanowania został zakończony.");
            break;
          }
          continue;
        }
        consecutiveFailures = 0;
        setScanProgress(payload);
        if (!hasActiveBackendWork(payload)) {
          setNotice(payload.status === "partial" || payload.status === "failed" ? "Skan zakończył się z błędami." : `Skan zakończony. Znaleziono ${formatNumber(payload.totals.matched)} dopasowań.`);
          await load();
          setResultsRevision((current) => current + 1);
          break;
        }
        if (!isTerminalScanStatus(payload.status)) continue;
        setNotice(payload.status === "partial" || payload.status === "failed" ? "Skan zakończył się z błędami. Oferty z poprawnie zakończonych etapów pozostały dostępne." : `Skan zakończony. Znaleziono ${formatNumber(payload.totals.matched)} dopasowań.`);
        await load();
        setResultsRevision((current) => current + 1);
        break;
      }
    } finally {
      finishScanning(filterId);
    }
  };

  const manageFilter = async (filter: SearchFilterListItem, action: "toggle" | "duplicate" | "delete") => {
    setError(null);
    setNotice(null);
    const endpoint = action === "delete"
      ? `/api/flip-finder/search-filters/${filter.id}`
      : `/api/flip-finder/search-filters/${filter.id}/${action}`;
    const response = await fetch(endpoint, { method: action === "delete" ? "DELETE" : "POST" });
    const payload: unknown = response.status === 204 ? null : await readJson(response);

    if (!response.ok) {
      throw new Error(readMessage(payload, "Nie udało się wykonać operacji na filtrze."));
    }

    await load();
    setNotice(
      action === "delete"
        ? "Filtr został usunięty."
        : action === "duplicate"
          ? "Utworzono kopię filtra."
          : filter.isActive
            ? "Filtr został wstrzymany."
            : "Filtr został wznowiony.",
    );
  };

  if (data === null && error === null) {
    return <DashboardLoadingState />;
  }

  if (data === null) {
    return <DashboardErrorState message={error ?? "Nie udało się pobrać danych Flip Findera."} onRetry={load} />;
  }

  const activeFilter = data.filters.find((filter) => filter.id === requestedFilterId) ?? data.filters.find((filter) => filter.isActive) ?? data.filters[0] ?? null;

  return (
    <div className="space-y-6 sm:space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Flip Finder</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Oferty są wyszukiwane wyłącznie według zapisanych filtrów.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button nativeButton={false} render={<Link href="/facebook-watcher/groups" />} variant="outline">
            Dodaj grupę Facebook
          </Button>
          <Button nativeButton={false} render={<Link href="/flip-finder/filters/new" />}>
            Nowy filtr
          </Button>
        </div>
      </header>

      {activeFilter ? (
        <Card className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{activeFilter.name}</h2>
                <FilterStatusBadge isActive={activeFilter.isActive} />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{formatFilterLocation(activeFilter)}</span>
                <span>Maks. cena/m²: {activeFilter.maxPricePerSqm !== null ? formatCurrency(activeFilter.maxPricePerSqm) : "Nie ustawiono"}</span>
                <span>Powierzchnia: {formatAreaRange(activeFilter)}</span>
                <span>Pokoje: {activeFilter.rooms.length ? activeFilter.rooms.join(", ") : "Nie ustawiono"}</span>
                <span>Aktywne źródła: {activeFilter.sources.map(sourceLabel).join(", ")}</span>
              </div>
            </div>
            <Button
              className="h-12 px-6 text-base"
              disabled={!canRunManualScan(activeFilter.isActive, scanningFilterIds.has(activeFilter.id))}
              onClick={() => void scanFilter(activeFilter)}
            >
              {scanningFilterIds.has(activeFilter.id) ? "Skanowanie…" : "Skanuj oferty"}
            </Button>
            {scanningFilterIds.has(activeFilter.id) ? (
              <Button className="h-12 px-6 text-base" onClick={() => void stopScan(activeFilter)} variant="destructive">
                Zatrzymaj skanowanie
              </Button>
            ) : null}
            <FilterActions filter={activeFilter} onAction={manageFilter} />
          </div>
          {scanProgress && (scanProgress.runId === activeScanRunId || scanProgress.runId === activeFilter.lastScan?.scanRunId || scanningFilterIds.has(activeFilter.id)) ? <ScanProgressPanel progress={scanProgress} /> : null}
          <InlineFilterResults key={`${activeFilter.id}-${resultsRevision}`} filterId={activeFilter.id} />
          {scanProgress && (scanProgress.runId === activeScanRunId || scanProgress.runId === activeFilter.lastScan?.scanRunId || scanningFilterIds.has(activeFilter.id)) ? <VisionCostPanel progress={scanProgress} /> : null}
        </Card>
      ) : (
        <section className="rounded-xl border border-dashed bg-card p-6 text-center">
          <h2 className="font-semibold">Utwórz pierwszy filtr wyszukiwania</h2>
          <p className="mt-2 text-sm text-muted-foreground">Po zapisaniu filtra w tym miejscu pojawią się dopasowane oferty.</p>
        </section>
      )}

      {notice ? (
        <p
          aria-live="polite"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <p>{error}</p>
          {startTrace ? <Button className="mt-2" onClick={() => setShowStartTrace((value) => !value)} size="sm" variant="outline">Pokaż diagnostykę</Button> : null}
          {showStartTrace && startTrace ? <StartTraceSummary trace={startTrace} /> : null}
          {retryFilterId ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={scanningFilterIds.has(retryFilterId)}
                onClick={() => {
                  const filter = data.filters.find((item) => item.id === retryFilterId);
                  if (filter) {
                    void scanFilter(filter);
                  }
                }}
                size="sm"
                variant="outline"
              >
                Spróbuj ponownie
              </Button>
              <Button
                nativeButton={false}
                render={<Link href="/properties/new" />}
                size="sm"
                variant="outline"
              >
                Importuj ofertę z linku
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {lastScanDiagnostics ? (
        <ScanDiagnosticsPanel filter={lastScanDiagnostics.filter} response={lastScanDiagnostics.response} />
      ) : null}

      <section aria-label="Statystyki Flip Findera" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatisticCard label="Aktywne filtry" value={data.summary.activeFilters ?? 0} />
        <StatisticCard label="Wstrzymane filtry" value={data.summary.pausedFilters ?? 0} />
        <StatisticCard label="Aktywne oferty" value={data.summary.activeListings ?? 0} />
        <StatisticCard label="Usunięte / nieaktywne" value={data.summary.removedListings ?? 0} />
        <StatisticCard label="Łączna historia" value={data.summary.listingsCount ?? 0} />
        <StatisticCard label="Nowe w ostatnim skanie" value={data.summary.newMatches ?? 0} />
      </section>

      <LatestScanPanel scan={data.latestScan} filters={data.filters} />

      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Ostatnie filtry</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Skanuj zapisane konfiguracje i przejdź do dopasowanych ofert.
            </p>
          </div>
          <Button
            nativeButton={false}
            size="sm"
            variant="outline"
            render={<Link href="/flip-finder/filters" />}
          >
            Zarządzaj filtrami
          </Button>
        </div>

        {data.filters.length === 0 ? (
          <EmptyFiltersState />
        ) : (
          <ul className="mt-5 space-y-3">
            {data.filters.slice(0, 5).map((filter) => {
              const scanning = scanningFilterIds.has(filter.id);
              const canScan = canRunManualScan(filter.isActive, scanning);

              return (
                <li key={filter.id} className="rounded-xl border bg-muted/20 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{filter.name}</h3>
                        <FilterStatusBadge isActive={filter.isActive} />
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatFilterLocation(filter)}
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {filter.priceMax !== null ? (
                          <span>Maks. cena: {formatCurrency(filter.priceMax)}</span>
                        ) : null}
                        {filter.maxPricePerSqm !== null ? (
                          <span>Maks. cena/m²: {formatCurrency(filter.maxPricePerSqm)}</span>
                        ) : null}
                        <span>Wszystkie dopasowania: {formatNumber(filter.totalMatches ?? 0)}</span>
                        <span>Nowe dopasowania: {formatNumber(filter.newMatches ?? 0)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {filter.lastScan
                          ? `Ostatni skan: ${formatDateTime(filter.lastScan.startedAt)}`
                          : "Skan nie został jeszcze uruchomiony."}
                      </p>
                      {!filter.isActive ? (
                        <p className="text-xs text-muted-foreground">
                          Wstrzymany filtr nie może zostać uruchomiony.
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        disabled={!canScan}
                        onClick={() => void scanFilter(filter)}
                        size="sm"
                      >
                        {scanning ? "Skanowanie…" : "Skanuj teraz"}
                      </Button>
                      <Button
                        nativeButton={false}
                        render={<Link href={filterResultsHref(filter.id)} />}
                        size="sm"
                        variant="outline"
                      >
                        Zobacz wyniki
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ScanDiagnosticsPanel({ filter, response }: { filter: SearchFilterListItem; response: ScanResponse }) {
  const diagnostics = response.matchDiagnostics;
  if (!diagnostics) return null;

  const analyzed = response.scannedCount;
  const reasons = [
    { key: "price", label: "Cena", count: diagnostics.rejectedByPrice },
    { key: "pricePerSqm", label: "Cena/m²", count: diagnostics.rejectedByPricePerSqm },
    { key: "rooms", label: "Pokoje", count: diagnostics.rejectedByRooms },
    { key: "area", label: "Metraż", count: diagnostics.rejectedByArea },
    { key: "district", label: "Dzielnica", count: diagnostics.rejectedByDistrict },
    { key: "buildingType", label: "Typ budynku", count: diagnostics.rejectedByBuildingType },
  ];
  const restrictiveReason = reasons.find((reason) => percentage(reason.count, analyzed) > 80);

  return (
    <Card aria-label="Diagnostyka dopasowania ofert" className="overflow-hidden border-gold/20 bg-gradient-to-br from-gold/[0.07] via-card to-card p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold">Diagnostyka filtra</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Dlaczego oferty odpadły?</h2>
          <p className="mt-2 text-sm text-muted-foreground">Raport z ostatniego zakończonego skanu filtra „{filter.name}”.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:min-w-64">
          <DiagnosticMetric label="Analizowane oferty" value={analyzed} />
          <DiagnosticMetric label="Dopasowane" value={diagnostics.matched} tone="gold" />
        </div>
      </div>

      {restrictiveReason ? (
        <div className="mt-5 rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm">
          <p className="font-semibold text-warning">Ten filtr jest bardzo restrykcyjny.</p>
          {restrictiveReason.key === "pricePerSqm" && filter.maxPricePerSqm !== null ? (
            <p className="mt-1 text-muted-foreground">{restrictiveReason.count} z {analyzed} ofert odpadło przez limit {formatNumber(filter.maxPricePerSqm)} zł/m².</p>
          ) : (
            <p className="mt-1 text-muted-foreground">Warunek „{restrictiveReason.label}” odrzucił {formatPercent(restrictiveReason.count, analyzed)} analizowanych ofert.</p>
          )}
          <Link className={buttonVariants({ className: "mt-3", size: "sm", variant: "outline" })} href={`/flip-finder/filters/${filter.id}/edit?returnTo=%2Fflip-finder&activeFilter=${filter.id}`}>Edytuj ten limit</Link>
        </div>
      ) : null}

      <div className="mt-6 space-y-3">
        {reasons.map((reason) => <DiagnosticBar analyzed={analyzed} count={reason.count} key={reason.key} label={reason.label} />)}
      </div>

      <div className="mt-6 border-t border-border/60 pt-5">
        <h3 className="text-sm font-semibold">Diagnostyka per źródło</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {(response.sourceResults ?? []).map((source) => <SourceDiagnosticCard key={source.source} source={source} />)}
        </div>
      </div>
    </Card>
  );
}

function DiagnosticMetric({ label, value, tone }: { label: string; value: number; tone?: "gold" }) {
  return <div className="rounded-xl border border-border/60 bg-surface-elevated/70 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className={`mt-1 font-mono text-2xl font-semibold ${tone === "gold" ? "text-gold" : ""}`}>{formatNumber(value)}</p></div>;
}

function DiagnosticBar({ analyzed, count, label }: { analyzed: number; count: number; label: string }) {
  const value = percentage(count, analyzed);
  return <div><div className="mb-1.5 flex items-center justify-between gap-4 text-sm"><span className="text-muted-foreground">{label}</span><span className="font-mono"><strong className="text-foreground">{formatNumber(count)}</strong><span className="ml-3 text-muted-foreground">{formatPercent(count, analyzed)}</span></span></div><div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-gradient-to-r from-gold-muted to-gold transition-[width] duration-500" style={{ width: `${value}%` }} /></div></div>;
}

function SourceDiagnosticCard({ source }: { source: NonNullable<ScanResponse["sourceResults"]>[number] }) {
  const reason = mainDiagnosticReason(source.matchDiagnostics);
  if (source.status === "pending") return <div className="rounded-xl border border-gold/20 bg-gold/[0.05] p-4"><p className="font-semibold">{sourceDisplayLabel(source.source)}</p><p className="mt-3 text-sm text-muted-foreground">{sourceDisplayLabel(source.source)}: oczekuje na lokalny worker</p></div>;
  return <div className="rounded-xl border border-border/60 bg-surface-elevated/60 p-4"><div className="flex items-center justify-between gap-3"><p className="font-semibold">{sourceDisplayLabel(source.source)}</p><span className={`ui-badge ${source.status === "failed" ? "border-danger/20 bg-danger/10 text-danger" : "border-success/20 bg-success/10 text-success"}`}>{source.status === "failed" ? "Błąd" : "Zakończony"}</span></div>{source.status === "failed" ? <p className="mt-3 text-sm text-danger">{source.errorMessage ?? "Źródło nie zakończyło skanu."}</p> : <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">Sprawdzone</dt><dd className="mt-0.5 font-mono font-semibold">{formatNumber(source.fetched ?? 0)}</dd></div><div><dt className="text-xs text-muted-foreground">Dopasowane</dt><dd className="mt-0.5 font-mono font-semibold text-gold">{formatNumber(source.matched ?? source.matchDiagnostics?.matched ?? 0)}</dd></div><div className="col-span-2"><dt className="text-xs text-muted-foreground">Główny powód odrzucenia</dt><dd className="mt-0.5 font-medium">{reason}</dd></div></dl>}</div>;
}

function mainDiagnosticReason(diagnostics: MatchDiagnostics | undefined): string {
  if (!diagnostics) return "Brak danych";
  const reasons = [
    ["Cena/m²", diagnostics.rejectedByPricePerSqm], ["Cena", diagnostics.rejectedByPrice], ["Pokoje", diagnostics.rejectedByRooms], ["Metraż", diagnostics.rejectedByArea], ["Dzielnica", diagnostics.rejectedByDistrict], ["Typ budynku", diagnostics.rejectedByBuildingType],
  ] as const;
  const main = reasons.reduce((current, reason) => reason[1] > current[1] ? reason : current, reasons[0]);
  return main[1] > 0 ? `${main[0]} · ${formatNumber(main[1])}` : "Brak odrzuceń";
}

function percentage(value: number, total: number): number { return total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0; }
function formatPercent(value: number, total: number): string { return `${percentage(value, total).toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`; }
function sourceDisplayLabel(value: string): string { return value === "otodom" ? "Otodom" : value === "olx" ? "OLX" : value === "morizon" ? "Morizon" : value === "facebook" ? "Facebook" : value; }

function FilterActions({ filter, onAction }: { filter: SearchFilterListItem; onAction: (filter: SearchFilterListItem, action: "toggle" | "duplicate" | "delete") => Promise<void> }) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (action: "toggle" | "duplicate" | "delete") => {
    setBusy(true);
    setActionError(null);
    try {
      await onAction(filter, action);
      setConfirmationOpen(false);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Nie udało się wykonać operacji.");
    } finally {
      setBusy(false);
    }
  };
  const editHref = `/flip-finder/filters/${filter.id}/edit?returnTo=%2Fflip-finder&activeFilter=${filter.id}`;
  const actionButtons = (
    <>
      <Button nativeButton={false} render={<Link href={editHref} />} size="sm" variant="outline">Edytuj filtr</Button>
      <Button disabled={busy} onClick={() => void run("toggle")} size="sm" variant="outline">{filter.isActive ? "Wstrzymaj" : "Wznów"}</Button>
      <Button disabled={busy} onClick={() => void run("duplicate")} size="sm" variant="outline">Duplikuj</Button>
    </>
  );

  return (
    <div className="flex items-center gap-2">
      <div className="hidden items-center gap-2 md:flex">
        {actionButtons}
        <Button onClick={() => setConfirmationOpen(true)} size="sm" variant="destructive">Usuń</Button>
      </div>
      <details className="relative md:hidden">
        <summary className="flex size-10 cursor-pointer list-none items-center justify-center rounded-xl border border-border/80 bg-surface-elevated text-muted-foreground transition-colors hover:text-foreground"><MoreHorizontal className="size-4" /><span className="sr-only">Więcej akcji filtra</span></summary>
        <div className="absolute right-0 z-20 mt-2 flex w-44 flex-col gap-1 rounded-xl border border-border/80 bg-popover p-2 shadow-xl">
          <Link className="rounded-lg px-3 py-2 text-sm hover:bg-surface-hover" href={editHref}>Edytuj filtr</Link>
          <button className="rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover" disabled={busy} onClick={() => void run("toggle")}>{filter.isActive ? "Wstrzymaj" : "Wznów"}</button>
          <button className="rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover" disabled={busy} onClick={() => void run("duplicate")}>Duplikuj</button>
          <button className="rounded-lg px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10" onClick={() => setConfirmationOpen(true)}>Usuń</button>
        </div>
      </details>
      <Dialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Usunąć filtr?</DialogTitle><DialogDescription>Tej operacji nie można cofnąć.</DialogDescription></DialogHeader>
          {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
          <DialogFooter><Button disabled={busy} onClick={() => void run("delete")} variant="destructive">{busy ? "Usuwanie…" : "Usuń filtr"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatisticCard({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <MetricCard label={label} value={formatNumber(dashboardCount(value ?? 0))} />
  );
}

function LatestScanPanel({
  scan,
  filters,
}: {
  scan: SearchFilterScan | null;
  filters: SearchFilterListItem[];
}) {
  if (!hasLatestScan(scan)) {
    return (
      <section className="rounded-xl border border-dashed bg-card p-5">
        <h2 className="font-semibold">Skanowanie ofert</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {NO_SCANS_MESSAGE}
        </p>
      </section>
    );
  }

  const filterName = filters.find((filter) => filter.id === scan.searchFilterId)?.name;
  const counters = latestScanCounters(scan);

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold">Skanowanie ofert</h2>
          {filterName ? <p className="mt-1 text-sm text-muted-foreground">Filtr: {filterName}</p> : null}
        </div>
        <ScanStatusBadge status={scan.status} />
      </div>

      <dl className="mt-5 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <ScanDetail label="Źródło" value={sourceLabel(scan.source)} />
        <ScanDetail label="Rozpoczęcie" value={formatDateTime(scan.startedAt)} />
        {scan.finishedAt ? <ScanDetail label="Zakończenie" value={formatDateTime(scan.finishedAt)} /> : null}
        <ScanDetail label="Sprawdzone oferty" value={formatNumber(scan.scannedCount ?? 0)} />
        <ScanDetail label="Globalnie nowe oferty" value={formatNumber(scan.listingsCreated ?? 0)} />
        <ScanDetail label="Nowe dopasowania" value={formatNumber(scan.newCount ?? 0)} />
        <ScanDetail label="Aktualizacje" value={formatNumber(counters.updatedCount)} />
        <ScanDetail label="Obniżki cen" value={formatNumber(counters.priceDropCount)} />
        <ScanDetail label="Błędy" value={formatNumber(scan.errorsCount ?? 0)} />
      </dl>

      {scan.status === "pending" && (scan.source === "olx" || scan.source === "facebook") ? (
        <p className="mt-5 text-sm text-muted-foreground" role="status">{scan.source === "facebook" ? "Facebook: oczekuje na production Collector" : "OLX: oczekuje na lokalny worker"}</p>
      ) : null}
      {scan.status === "running" ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span className="size-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Trwa pobieranie i zapisywanie ofert.
        </p>
      ) : null}
      {scan.errorMessage ? (
        <p className="mt-5 text-sm text-destructive">{scan.errorMessage}</p>
      ) : null}
    </Card>
  );
}

function ScanDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function ScanStatusBadge({ status }: { status: SearchFilterScan["status"] }) {
  const className =
    status === "failed"
      ? "bg-destructive/10 text-destructive"
      : status === "completed"
        ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
        : status === "partial"
          ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
          : "bg-blue-500/10 text-blue-800 dark:text-blue-300";

  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>{scanStatusLabel(status)}</span>;
}

function FilterStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={
        isActive
          ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:text-emerald-300"
          : "rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      }
    >
      {isActive ? "Aktywny" : "Wstrzymany"}
    </span>
  );
}

function EmptyFiltersState() {
  return (
    <div className="mt-5 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
      <p>Nie masz jeszcze zapisanych filtrów wyszukiwania.</p>
      <Button
        nativeButton={false}
        className="mt-3"
        render={<Link href="/flip-finder/filters/new" />}
        size="sm"
      >
        Utwórz pierwszy filtr
      </Button>
    </div>
  );
}

function DashboardLoadingState() {
  return (
    <div className="space-y-6" role="status">
      <Skeleton className="h-16" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-48" />
    </div>
  );
}

function DashboardErrorState({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5">
      <h1 className="font-semibold">Flip Finder</h1>
      <p className="mt-2 text-sm text-destructive">{message}</p>
      <Button className="mt-4" onClick={() => void onRetry()} size="sm" variant="outline">
        Spróbuj ponownie
      </Button>
    </div>
  );
}

function formatFilterLocation(filter: SearchFilterListItem): string {
  const city = filter.city?.trim() || "Nie ustawiono miasta";
  const districts = filter.districts.filter(Boolean).join(", ");

  return districts ? `${city} · ${districts}` : city;
}

function formatAreaRange(filter: SearchFilterListItem): string {
  if (filter.areaMin !== null && filter.areaMax !== null) {
    return `${filter.areaMin}–${filter.areaMax} m²`;
  }

  if (filter.areaMin !== null) {
    return `od ${filter.areaMin} m²`;
  }

  if (filter.areaMax !== null) {
    return `do ${filter.areaMax} m²`;
  }

  return "Nie ustawiono";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("pl-PL").format(dashboardCount(value));
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "PLN",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Nie ustawiono";
  }

  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function sourceLabel(source: SearchFilterScan["source"]): string {
  return source === "otodom" ? "Otodom" : source === "olx" ? "OLX" : source === "morizon" ? "Morizon" : "Facebook";
}

function scanErrorMessage(status: number, payload: unknown): string {
  const apiMessage = readMessage(payload, "");

  if (apiMessage === OTODOM_AUTOMATION_BLOCKED_MESSAGE) {
    return apiMessage;
  }

  if (status === 429) {
    return "Skan tego filtra już trwa.";
  }

  if (status === 409) {
    return "Nie można uruchomić skanu dla wstrzymanego filtra.";
  }

  if (status === 404) {
    return "Nie znaleziono wybranego filtra.";
  }

  if (status === 400) {
    return readMessage(payload, "Filtr nie zawiera obsługiwanego źródła ofert.");
  }

  if (status === 502 || status === 504) {
    return "Nie udało się połączyć ze źródłem ofert. Spróbuj ponownie później.";
  }

  return readMessage(payload, "Nie udało się wykonać skanu.");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchScanProgress(runId: string): Promise<ScanProgressResponse> {
  const response = await apiFetch(`/api/flip-finder/scans/${runId}`, { cache: "no-store" });
  const payload = await readJson(response);
  if (!response.ok || !isScanProgressResponse(payload)) {
    throw new Error(readMessage(payload, "Nie udało się pobrać postępu skanu."));
  }
  return payload;
}

type CollectorBridgeResult = { ok: boolean; accepted?: boolean; status?: string; label?: string; error?: string };
type StartTraceStage = { requestId: string; stage: string; timestamp: string; status: "PASS" | "FAIL" | "TIMEOUT"; errorCode?: string; attempt?: number };
type StartTrace = { requestId: string; stages: StartTraceStage[] };
const START_TRACE_KEY = "flip-finder-start-trace";

function requestCollectorReady(requestId: string, attempt: number): Promise<CollectorBridgeResult> {
  traceStage(requestId, "READY_REQUEST_SENT", "PASS", undefined, attempt);
  return requestCollectorMessage("FLIP_COLLECTOR_READY_REQUEST", "FLIP_COLLECTOR_READY_RESULT", requestId, {}, "PAGE_RECEIVED_READY");
}

async function requestCollectorBridgePing(requestId: string): Promise<CollectorBridgeResult> {
  const bootstrapLoaded = await waitForBootstrapMarker();
  traceStage(requestId, "BOOTSTRAP_SCRIPT_EXECUTED", bootstrapLoaded ? "PASS" : "FAIL", bootstrapLoaded ? undefined : "BOOTSTRAP_MARKER_MISSING");
  if (!bootstrapLoaded) return { ok: false, error: "Rozszerzenie Flip Collector nie jest aktywne na tej karcie." };
  traceStage(requestId, "BOOTSTRAP_PING_SENT", "PASS");
  const bootstrap = await requestCollectorMessage("FLIP_COLLECTOR_BOOTSTRAP_PING", "FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, {}, "BOOTSTRAP_PONG_RECEIVED", 3_000);
  if (!bootstrap.ok) return bootstrap;
  traceStage(requestId, "BRIDGE_PING_SENT", "PASS");
  return requestCollectorMessage("FLIP_COLLECTOR_BRIDGE_PING", "FLIP_COLLECTOR_BRIDGE_PONG", requestId, {}, "BRIDGE_PONG_RECEIVED", 3_000);
}

async function waitForBootstrapMarker(timeoutMs = 1_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const marker = document.documentElement?.getAttribute("data-flip-collector-bootstrap");
    if (marker && marker !== "stale") return true;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

function requestCollectorScan(runId: string, requestId: string): Promise<CollectorBridgeResult> {
  return requestCollectorMessage("FLIP_COLLECTOR_SCAN_REQUEST", "FLIP_COLLECTOR_SCAN_RESULT", requestId, { scanId: runId }, "PAGE_RECEIVED_SCAN_COMMAND");
}

function requestCollectorMessage(requestType: string, responseType: string, requestId: string, payload: Record<string, unknown>, responseStage: string, timeoutMs = 5_000): Promise<CollectorBridgeResult> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => { window.removeEventListener("message", listener); traceStage(requestId, responseStage, "TIMEOUT", responseStage === "BOOTSTRAP_PONG_RECEIVED" ? "BOOTSTRAP_NO_RESPONSE" : responseStage === "BRIDGE_PONG_RECEIVED" ? "BRIDGE_NOT_INJECTED_OR_INACTIVE" : "COLLECTOR_BRIDGE_NO_RESPONSE"); resolve({ ok: false, error: "Nie wykryto aktywnego Flip Collectora." }); }, timeoutMs);
    function listener(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== responseType) return;
      if (event.data.requestId !== requestId) { traceStage(requestId, responseStage, "FAIL", "REQUEST_ID_MISMATCH"); return; }
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      traceStage(requestId, responseStage, event.data.ok === true ? "PASS" : "FAIL", event.data.ok === true ? undefined : safeTraceError(String(event.data.error || "READY_FAILED")));
      resolve({ ok: event.data.ok === true, accepted: event.data.accepted === true, status: typeof event.data.status === "string" ? event.data.status : undefined, label: typeof event.data.label === "string" ? event.data.label : undefined, error: typeof event.data.error === "string" ? event.data.error : undefined });
    }
    window.addEventListener("message", listener);
    window.postMessage({ type: requestType, requestId, ...payload }, window.location.origin);
  });
}

function traceStage(requestId: string, stage: string, status: StartTraceStage["status"], errorCode?: string, attempt?: number): void {
  try {
    const current = JSON.parse(window.sessionStorage.getItem(START_TRACE_KEY) || "null") as StartTrace | null;
    const trace = current?.requestId === requestId ? current : { requestId, stages: [] };
    trace.stages.push({ requestId, stage, timestamp: new Date().toISOString(), status, ...(errorCode ? { errorCode: safeTraceError(errorCode) } : {}), ...(attempt ? { attempt } : {}) });
    window.sessionStorage.setItem(START_TRACE_KEY, JSON.stringify({ requestId, stages: trace.stages.slice(-80) }));
  } catch { /* diagnostics must never block scan start */ }
}
function safeTraceError(value: string): string { return value.replace(/token|secret|cookie|hmac/gi, "redacted").slice(0, 120).replace(/[^A-Za-z0-9_.:-]/g, "_"); }

function readStartTrace(): StartTrace | null {
  try { return JSON.parse(window.sessionStorage.getItem(START_TRACE_KEY) || "null") as StartTrace | null; } catch { return null; }
}

function StartTraceSummary({ trace }: { trace: StartTrace }) {
  const summary = summarizeStartTrace(trace.stages);
  const last = trace.stages.at(-1);
  return <div className="mt-2 rounded border p-2 text-xs"><div>requestId: {trace.requestId}</div><div>Last stage: {last?.stage || "—"}</div><div>Last successful real stage: {summary.lastSuccessful || "—"}</div><div>First failed/missing: {summary.firstFailed || summary.firstMissing || "—"}</div><div>Error: {summary.errorCode || "—"}</div><div>Diagnosis: {traceDiagnosis(summary.firstFailed || summary.firstMissing || undefined, summary.errorCode || undefined)}</div></div>;
}
function traceDiagnosis(stage?: string, errorCode?: string): string {
  if (errorCode === "REQUEST_ID_MISMATCH") return "REQUEST_ID_MISMATCH";
  if (stage === "BUTTON_CLICKED") return "BUTTON_HANDLER_FAILED";
  if (stage === "READY_REQUEST_SENT") return "BRIDGE_NOT_INJECTED";
  if (stage === "BRIDGE_PONG_RECEIVED") return "BRIDGE_NOT_INJECTED_OR_INACTIVE";
  if (stage === "PAGE_RECEIVED_READY") return "READY_RESPONSE_TIMEOUT";
  if (stage === "POST_SCAN_RESPONSE") return "POST_SCAN_FAILED";
  if (stage === "SCAN_COMMAND_SENT" || stage === "PAGE_RECEIVED_SCAN_COMMAND") return "SCAN_COMMAND_NOT_RECEIVED";
  return "COLLECTOR_START_FAILED";
}

function isScanProgressResponse(value: unknown): value is ScanProgressResponse {
  return Boolean(value && typeof value === "object" && "runId" in value && "status" in value && "overall" in value && "facebook" in value && "olx" in value && "openai" in value);
}

function readMessage(value: unknown, fallback: string): string {
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return value.message;
  }

  return fallback;
}

function isSearchFilterListResponse(value: unknown): value is SearchFilterListResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "filters" in value &&
    Array.isArray(value.filters) &&
    "summary" in value &&
    "latestScan" in value
  );
}

function isScanResponse(value: unknown): value is ScanResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "scannedCount" in value &&
    typeof value.scannedCount === "number" &&
    "matchedCount" in value &&
    typeof value.matchedCount === "number" &&
    "newCount" in value &&
    typeof value.newCount === "number" &&
    "updatedCount" in value &&
    typeof value.updatedCount === "number" &&
    "priceDropCount" in value &&
    typeof value.priceDropCount === "number"
  );
}
