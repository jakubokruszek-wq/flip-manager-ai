"use client";

import { budgetTone, type ScanProgressResponse } from "@/features/flip-finder/scan-progress";

export function ScanProgressPanel({ progress }: { progress: ScanProgressResponse }) {
  const active = progress.status === "queued" || progress.status === "running";
  // Finder's own scan never has a Facebook group name of its own -- it only
  // reconciles already-collected canonical listings (see
  // reconcileFacebookFromCanonicalListings) and always completes that step
  // synchronously. A groupName here can only originate from the Facebook
  // Watcher's own, separate scan cycle; this panel must never name a
  // specific Facebook group, matching Finder's read-only relationship to
  // Facebook data everywhere else in this codebase.
  const currentLabel = progress.current
    ? progress.current.source === "facebook"
      ? "Facebook — przeliczono z zapisanych ofert"
      : sourceLabel(progress.current.source)
    : null;
  const tone = budgetTone(progress.openai.budgetUsedPercent);
  const terminalStage = progress.status === "partial"
    ? "Częściowo zakończony"
    : progress.status === "failed"
      ? "Zakończony błędem"
      : "Wszystkie etapy zakończone";

  return (
    <section aria-label="Postęp skanowania" className="rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-sm font-semibold">{active ? "Skanowanie…" : statusLabel(progress.status)}</p><p className="mt-1 text-xs text-muted-foreground">{progress.overall.completedUnits}/{progress.overall.totalUnits} etapów · {formatDuration(progress.elapsedMs)}</p></div>
          <span className={statusClass(progress.status)}>{statusLabel(progress.status)}</span>
        </div>
        <div aria-label={`Postęp ${progress.overall.percent}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress.overall.percent} className="mt-4 h-2.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${progress.overall.percent}%` }} /></div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <ProgressDetail label="Bieżący etap" value={currentLabel ?? (active ? "Oczekiwanie na Collector" : terminalStage)} />
          <ProgressDetail label="Pozostało" value={`${progress.overall.remainingUnits} etapów`} />
          {progress.olx.status ? <ProgressDetail label="OLX" value={`${jobStatusLabel(progress.olx.status)} · raw ${progress.olx.raw} · normalized ${progress.olx.normalized}`} /> : null}
        </div>
        {progress.status === "partial" ? <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm"><p className="font-semibold text-amber-800 dark:text-amber-300">Częściowo zakończony</p><p className="mt-1 text-muted-foreground">{progress.partialReason ?? "Collector zakończył pracę, ale część SEARCH została pominięta lub ograniczona."}</p></div> : null}
        {/*
          Deliberately no Facebook per-group (or even aggregate group-count)
          breakdown here. That data -- group names, per-group post counts,
          collector queue status -- can only ever describe the Facebook
          Watcher's own, separately scheduled scan cycle: Finder's own scan
          never creates facebook_scan_jobs or per-group source_scans rows at
          all (see reconcileFacebookFromCanonicalListings in manual-scan.ts).
          Rendering it here previously made Finder's page look like it was
          scanning Facebook groups itself, confirmed live in production.
        */}
        {progress.errors.length > 0 ? <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">{progress.errors.slice(0, 3).map((message) => <p key={message}>{message}</p>)}</div> : null}
      </div>

      {/* Vision cost telemetry is rendered below the results by VisionCostPanel. */}
      <div className="hidden" aria-hidden="true">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">OpenAI Vision</h3><span className="text-xs text-muted-foreground">{qualityLabel(progress.openai.lastRun.dataQuality)}</span></div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <CostMetric label="Ostatni skan" value={formatUsd(progress.openai.lastRun.costUsd)} />
          <CostMetric label="Wywołania" value={formatNumber(progress.openai.lastRun.calls)} />
          <CostMetric label="Tokeny" value={formatNumber(progress.openai.lastRun.totalTokens)} />
          <CostMetric label="Dzisiaj" value={formatUsd(progress.openai.today.costUsd)} />
          <CostMetric label="Ten miesiąc" value={formatUsd(progress.openai.month.costUsd)} />
          <CostMetric label="Budżet miesięczny" value={progress.openai.monthlyBudgetUsd === null ? "Nie ustawiono" : formatUsd(progress.openai.monthlyBudgetUsd)} />
          {progress.openai.remainingBudgetUsd !== null ? <CostMetric label="Pozostały budżet Flip Manager" value={formatUsd(progress.openai.remainingBudgetUsd)} /> : null}
        </dl>
        {progress.openai.monthlyBudgetUsd !== null && progress.openai.budgetUsedPercent !== null ? <div className="mt-4"><div className="mb-1.5 flex justify-between gap-3 text-xs text-muted-foreground"><span>Budżet miesięczny {formatUsd(progress.openai.monthlyBudgetUsd)}</span><span>{progress.openai.budgetUsedPercent.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%</span></div><div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className={`h-full rounded-full ${budgetToneClass(tone)}`} style={{ width: `${Math.min(100, progress.openai.budgetUsedPercent)}%` }} /></div></div> : null}
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

function ProgressDetail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-medium" title={value}>{value}</p></div>; }
function CostMetric({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 tabular-nums font-semibold">{value}</dd></div>; }
function sourceLabel(source: string): string { return ({ otodom: "Otodom", olx: "OLX", morizon: "Morizon", facebook: "Facebook Watcher", gratka: "Gratka", nieruchomosci_online: "Nieruchomosci-online.pl", domiporta: "Domiporta", sprzedajemy: "Sprzedajemy.pl", adresowo: "Adresowo.pl", oferty_net: "Oferty.net", szybko: "Szybko.pl", bezposrednio: "Bezposrednio.net.pl", domy: "Domy.pl", allegro_lokalnie: "Allegro Lokalnie" } as Record<string, string>)[source] ?? source; }
function jobStatusLabel(status: string): string { return status === "queued" ? "oczekuje" : status === "running" ? "w toku" : status === "failed" ? "błąd" : "zakończony"; }
function statusLabel(status: ScanProgressResponse["status"]): string { return status === "queued" ? "W kolejce" : status === "running" ? "W toku" : status === "completed" ? "Zakończony" : status === "partial" ? "Częściowo zakończony" : "Błąd"; }
function statusClass(status: ScanProgressResponse["status"]): string { const tone = status === "failed" ? "bg-destructive/10 text-destructive" : status === "partial" ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : status === "completed" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "bg-blue-500/10 text-blue-800 dark:text-blue-300"; return `rounded-full px-2.5 py-1 text-xs font-medium ${tone}`; }
function budgetToneClass(tone: ReturnType<typeof budgetTone>): string { return tone === "critical" ? "bg-destructive" : tone === "warning" ? "bg-amber-500" : tone === "info" ? "bg-blue-500" : "bg-emerald-500"; }
function qualityLabel(value: ScanProgressResponse["openai"]["lastRun"]["dataQuality"]): string { return value === "EXACT" ? "Dokładne usage" : value === "PARTIAL" ? "Częściowe usage" : "Usage niedostępne"; }
function formatNumber(value: number): string { return new Intl.NumberFormat("pl-PL").format(value); }
function formatUsd(value: number | null): string { return value === null ? "Brak danych" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "USD", minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value); }
function formatDuration(value: number): string { const seconds = Math.max(0, Math.floor(value / 1_000)); const minutes = Math.floor(seconds / 60); return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`; }
