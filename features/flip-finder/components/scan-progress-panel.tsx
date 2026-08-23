"use client";

import { budgetTone, type ScanProgressResponse } from "@/features/flip-finder/scan-progress";

export function ScanProgressPanel({ progress }: { progress: ScanProgressResponse }) {
  const active = progress.status === "queued" || progress.status === "running";
  const currentLabel = progress.current
    ? progress.current.source === "facebook" && progress.current.groupName
      ? `Facebook · ${progress.current.groupName}`
      : sourceLabel(progress.current.source)
    : null;
  const tone = budgetTone(progress.openai.budgetUsedPercent);

  return (
    <section aria-label="Postęp skanowania i koszt OpenAI" className="grid gap-4 rounded-2xl border border-border/70 bg-muted/20 p-4 lg:grid-cols-[1.35fr_1fr]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-sm font-semibold">{active ? "Skanowanie…" : statusLabel(progress.status)}</p><p className="mt-1 text-xs text-muted-foreground">{progress.overall.completedUnits}/{progress.overall.totalUnits} etapów · {formatDuration(progress.elapsedMs)}</p></div>
          <span className={statusClass(progress.status)}>{statusLabel(progress.status)}</span>
        </div>
        <div aria-label={`Postęp ${progress.overall.percent}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress.overall.percent} className="mt-4 h-2.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${progress.overall.percent}%` }} /></div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <ProgressDetail label="Bieżący etap" value={currentLabel ?? (active ? "Oczekiwanie na worker" : "Wszystkie etapy zakończone")} />
          <ProgressDetail label="Pozostało" value={`${progress.overall.remainingUnits} etapów`} />
          {progress.facebook.totalGroups > 0 ? <ProgressDetail label="Facebook" value={`${progress.facebook.completedGroups}/${progress.facebook.totalGroups} grup · ${progress.facebook.processed}/${progress.facebook.discovered} postów`} /> : null}
          {progress.olx.status ? <ProgressDetail label="OLX" value={`${jobStatusLabel(progress.olx.status)} · raw ${progress.olx.raw} · normalized ${progress.olx.normalized}`} /> : null}
        </div>
        {progress.errors.length > 0 ? <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">{progress.errors.slice(0, 3).map((message) => <p key={message}>{message}</p>)}</div> : null}
      </div>

      <div className="rounded-xl border border-border/60 bg-card p-4">
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

function ProgressDetail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-medium" title={value}>{value}</p></div>; }
function CostMetric({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 font-mono font-semibold">{value}</dd></div>; }
function sourceLabel(source: string): string { return source === "olx" ? "OLX" : source === "otodom" ? "Otodom" : source === "morizon" ? "Morizon" : "Facebook"; }
function jobStatusLabel(status: string): string { return status === "queued" ? "oczekuje" : status === "running" ? "w toku" : status === "failed" ? "błąd" : "zakończony"; }
function statusLabel(status: ScanProgressResponse["status"]): string { return status === "queued" ? "W kolejce" : status === "running" ? "W toku" : status === "completed" ? "Zakończony" : status === "partial" ? "Częściowo zakończony" : "Błąd"; }
function statusClass(status: ScanProgressResponse["status"]): string { const tone = status === "failed" ? "bg-destructive/10 text-destructive" : status === "partial" ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : status === "completed" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "bg-blue-500/10 text-blue-800 dark:text-blue-300"; return `rounded-full px-2.5 py-1 text-xs font-medium ${tone}`; }
function budgetToneClass(tone: ReturnType<typeof budgetTone>): string { return tone === "critical" ? "bg-destructive" : tone === "warning" ? "bg-amber-500" : tone === "info" ? "bg-blue-500" : "bg-emerald-500"; }
function qualityLabel(value: ScanProgressResponse["openai"]["lastRun"]["dataQuality"]): string { return value === "EXACT" ? "Dokładne usage" : value === "PARTIAL" ? "Częściowe usage" : "Usage niedostępne"; }
function formatNumber(value: number): string { return new Intl.NumberFormat("pl-PL").format(value); }
function formatUsd(value: number | null): string { return value === null ? "Brak danych" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "USD", minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value); }
function formatDuration(value: number): string { const seconds = Math.max(0, Math.floor(value / 1_000)); const minutes = Math.floor(seconds / 60); return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`; }
