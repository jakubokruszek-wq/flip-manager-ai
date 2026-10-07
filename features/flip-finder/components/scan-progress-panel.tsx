"use client";

import { budgetTone, type ScanProgressResponse } from "@/features/flip-finder/scan-progress";

export function ScanProgressPanel({ progress }: { progress: ScanProgressResponse }) {
  const waiting = (progress.overall.waitingUnits ?? 0) > 0;
  const active = (progress.status === "queued" || progress.status === "running") && !waiting;
  const workTimeMs = Math.max(0, progress.elapsedMs - progress.waitingAgeMs);
  const currentSource = progress.current
    ? progress.current.source === "facebook"
      ? "Facebook — przeliczono z zapisanych ofert"
      : sourceLabel(progress.current.source)
    : null;
  const currentText = waiting
    ? currentSource ?? "Kolejne źródło"
    : currentSource ?? (active ? "Oczekiwanie na źródło" : progress.status === "partial" ? "Zakończono częściowo" : progress.status === "failed" ? "Zakończono błędem" : "Wszystkie etapy zakończone");
  const technicalMessages = [...new Set([...progress.errors, ...(progress.partialReason ? [progress.partialReason] : [])])]
    .filter((message) => !isNormalYield(message));
  const statusText = waiting ? "Oczekuje" : active ? "W toku" : statusLabel(progress.status);

  return (
    <section aria-label="Postęp skanowania" className="min-w-0 rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Postęp skanu</h2>
            <p className="mt-1 text-xs text-muted-foreground">{progress.overall.completedUnits}/{progress.overall.totalUnits} etapów · czas pracy {formatDuration(workTimeMs)}</p>
          </div>
          <span className={statusClass(progress.status)}>{statusText}</span>
        </div>
        <div aria-label={"Postęp " + progress.overall.percent + "%"} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress.overall.percent} className="mt-4 h-2.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: progress.overall.percent + "%" }} />
        </div>
        <div className="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <ProgressDetail label={waiting ? "Oczekujące źródło" : "Aktualne źródło"} value={currentText} />
          <ProgressDetail label="Etapy pozostałe" value={String(progress.overall.remainingUnits)} />
          <ProgressDetail label="Sprawdzone oferty" value={String(progress.totals.scanned)} />
          <ProgressDetail label="Dopasowania" value={String(progress.totals.matched)} />
          <ProgressDetail label="Nowe / aktualizacje" value={progress.totals.created + " / " + progress.totals.updated} />
          {progress.olx.status ? <ProgressDetail label="OLX · surowe / poprawne" value={jobStatusLabel(progress.olx.status) + " · " + progress.olx.raw + " / " + progress.olx.normalized} /> : null}
        </div>
        {progress.status === "partial" && !waiting && technicalMessages.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">Część etapów zakończyła się błędem lub niepełnym wynikiem.</p> : null}
        {technicalMessages.length > 0 ? (
          <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
            <p>{polishErrorSummary(technicalMessages[0])}</p>
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer font-medium">Szczegóły techniczne</summary>
              <ul className="mt-2 list-disc space-y-1 break-words pl-5">
                {technicalMessages.slice(0, 10).map((message) => <li key={message}>{message}</li>)}
              </ul>
            </details>
          </div>
        ) : null}
        {/* Finder never renders Facebook Watcher per-group progress here. */}
      </div>
    </section>
  );
}

export function VisionCostPanel({ progress }: { progress: ScanProgressResponse }) {
  const tone = budgetTone(progress.openai.budgetUsedPercent);
  return (
    <section aria-label="OpenAI Vision" className="rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">OpenAI Vision</h3><span className="text-xs text-muted-foreground">{qualityLabel(progress.openai.lastRun.dataQuality)}</span></div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <CostMetric label="Ostatni skan" value={formatUsd(progress.openai.lastRun.costUsd)} />
        <CostMetric label="Wywołania" value={formatNumber(progress.openai.lastRun.calls)} />
        <CostMetric label="Tokeny" value={formatNumber(progress.openai.lastRun.totalTokens)} />
        <CostMetric label="Dzisiaj" value={formatUsd(progress.openai.today.costUsd)} />
        <CostMetric label="Ten miesiąc" value={formatUsd(progress.openai.month.costUsd)} />
        <CostMetric label="Budżet miesięczny" value={progress.openai.monthlyBudgetUsd === null ? "Nie ustawiono" : formatUsd(progress.openai.monthlyBudgetUsd)} />
        {progress.openai.remainingBudgetUsd !== null ? <CostMetric label="Pozostały budżet Flip Manager" value={formatUsd(progress.openai.remainingBudgetUsd)} /> : null}
      </dl>
      {progress.openai.monthlyBudgetUsd !== null && progress.openai.budgetUsedPercent !== null ? <div className="mt-4"><div className="mb-1.5 flex justify-between gap-3 text-xs text-muted-foreground"><span>Budżet miesięczny {formatUsd(progress.openai.monthlyBudgetUsd)}</span><span>{progress.openai.budgetUsedPercent.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%</span></div><div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className={`h-full rounded-full ${budgetToneClass(tone)}`} style={{ width: `${Math.min(100, progress.openai.budgetUsedPercent)}%` }} /></div></div> : null}
    </section>
  );
}

function ProgressDetail({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 whitespace-normal break-words font-medium [overflow-wrap:anywhere]">{value}</p></div>; }
function CostMetric({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 tabular-nums font-semibold">{value}</dd></div>; }
function sourceLabel(source: string): string { return ({ otodom: "Otodom", olx: "OLX", morizon: "Morizon", facebook: "Facebook Watcher", gratka: "Gratka", nieruchomosci_online: "Nieruchomosci-online.pl", domiporta: "Domiporta", sprzedajemy: "Sprzedajemy.pl", adresowo: "Adresowo.pl", oferty_net: "Oferty.net", szybko: "Szybko.pl", bezposrednio: "Bezposrednio.net.pl", domy: "Domy.pl", allegro_lokalnie: "Allegro Lokalnie", official_cooperative: "Spółdzielnie Łódź", official_uml: "UMŁ/BIP Łódź", official_auction: "Licytacje i syndycy" } as Record<string, string>)[source] ?? source; }
function jobStatusLabel(status: string): string { return status === "queued" ? "oczekuje" : status === "running" ? "w toku" : status === "failed" ? "błąd" : "zakończony"; }
function statusLabel(status: ScanProgressResponse["status"]): string { return status === "queued" ? "W kolejce" : status === "running" ? "W toku" : status === "completed" ? "Zakończony" : status === "partial" ? "Częściowo zakończony" : "Błąd"; }
function statusClass(status: ScanProgressResponse["status"]): string { const tone = status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"; return "rounded-full px-2.5 py-1 text-xs font-medium " + tone; }
function isNormalYield(message: string): boolean { return /^(SOURCE_BUDGET_EXHAUSTED|SOURCE_SLICE_YIELD):/u.test(message); }
function polishErrorSummary(message: string): string {
  if (/HTTP\s*403|FORBIDDEN/iu.test(message)) return "Źródło odmówiło dostępu (HTTP 403).";
  if (/AUTH|UNAUTHORIZED|JWT/iu.test(message)) return "Nie udało się potwierdzić uprawnień do wykonania etapu.";
  if (/RPC|DATABASE|SUPABASE|POSTGREST|PGRST/iu.test(message)) return "Wystąpił błąd zapisu lub odczytu danych.";
  if (/LEASE|CAS|OWNERSHIP/iu.test(message)) return "Utracono prawo do kontynuowania etapu.";
  if (/TIMEOUT|TIMED OUT/iu.test(message)) return "Etap przekroczył limit czasu.";
  return "Nie udało się zakończyć jednego z etapów skanu.";
}
function budgetToneClass(tone: ReturnType<typeof budgetTone>): string { return tone === "critical" ? "bg-destructive" : tone === "warning" ? "bg-amber-500" : tone === "info" ? "bg-blue-500" : "bg-emerald-500"; }
function qualityLabel(value: ScanProgressResponse["openai"]["lastRun"]["dataQuality"]): string { return value === "EXACT" ? "Dokładne usage" : value === "PARTIAL" ? "Częściowe usage" : "Usage niedostępne"; }
function formatNumber(value: number): string { return new Intl.NumberFormat("pl-PL").format(value); }
function formatUsd(value: number | null): string { return value === null ? "Brak danych" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "USD", minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value); }
function formatDuration(value: number): string { const seconds = Math.max(0, Math.floor(value / 1_000)); const minutes = Math.floor(seconds / 60); return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`; }
