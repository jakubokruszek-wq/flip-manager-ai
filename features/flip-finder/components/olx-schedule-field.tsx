"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { FINDER_OLX_DEFAULT_INTERVAL_MINUTES, FINDER_OLX_DEFAULT_START_TIME, FINDER_OLX_INTERVAL_OPTIONS_MINUTES, FINDER_OLX_START_TIME_OPTIONS, FINDER_OLX_TIME_ZONE } from "@/features/flip-finder/finder-schedule";

type LastSlot = { slotAt: string | null; status: string | null; reason: string | null; jobStatus: string | null; jobErrorCode: string | null; startedAt: string | null; finishedAt: string | null; workerId: string | null; delaySeconds: number | null };
type ScheduleStatus = {
  decision: "enqueued" | "due" | "skipped";
  reason: string | null;
  lastJobAt: string | null;
  lastJobStatus: string | null;
  lastJobAutomatic: boolean;
  nextAllowedAt: string | null;
  schedule?: { startTime: string | null; slotAt: string | null; nextSlotAt: string | null; graceUntil: string | null; blocker: string | null; lastSlot: LastSlot | null } | null;
  browserBudget?: { accountBrowserMs: number | null; safeBudgetMs: number | null; jobEstimateMs: number | null; remainingMs: number | null; fitsOneJob: boolean | null; reportedAt: string | null } | null;
  budget: { automaticJobs: number | null; automaticLimit: number; finderOtherJobs: number | null; radarJobs: number | null; cloudflareJobs: number | null; totalJobs: number | null; sharedLimit: number } | null;
  automation?: { available: boolean; enabled: boolean | null; recentJobs: Array<{ status: string; createdAt: string | null; workerId: string | null; errorCode: string | null }> } | null;
};

const REASONS: Record<string, string> = {
  FILTER_INACTIVE: "filtr jest wstrzymany",
  OLX_NOT_SELECTED: "OLX nie jest wybrany w zapisanym filtrze",
  OLX_JOB_IN_FLIGHT: "poprzednie zadanie OLX wciąż czeka lub trwa",
  OLX_INTERVAL_NOT_ELAPSED: "nie minął interwał OLX",
  AUTOMATIC_DAILY_BUDGET_USED: "wykorzystany globalny limit automatycznych skanów OLX na 24 h (wszystkie filtry)",
  SHARED_DAILY_BUDGET_USED: "wykorzystany wspólny budżet OLX na 24 h (razem z ręcznymi skanami)",
  BROWSER_BUDGET_INSUFFICIENT: "brak dziennego budżetu przeglądarki Cloudflare na kolejne zadanie",
  ANOTHER_FILTER_FIRST: "pierwszeństwo ma inny filtr z OLX, który czeka dłużej",
  BEFORE_FIRST_SLOT: "pierwszy termin jeszcze nie nadszedł",
  SLOT_ALREADY_HANDLED: "bieżący termin już obsłużono",
  SLOT_MISSED: "termin pominięty (bez nadrabiania)",
  NOT_ENQUEUED_WITHIN_GRACE: "nie zlecono w czasie tolerancji",
  OLX_INTERVAL_UNAVAILABLE: "harmonogram OLX niedostępny (migracja niezastosowana)",
  OLX_SCHEDULE_UNAVAILABLE: "harmonogram OLX niedostępny (migracja niezastosowana)",
  OLX_SCHEDULE_CHECK_FAILED: "nie udało się sprawdzić limitu; OLX nie jest zlecany",
};

export const OLX_CLOUDFLARE_LIMIT_TEXT = "OLX jest skanowany osobno od pozostałych portali, o stałych godzinach (czas polski), przez przeglądarkę Cloudflare (plan Free: 10 minut przeglądarki na dobę dla całego konta). Automatycznie najwyżej 1–2 skany OLX na 24 h dla wszystkich filtrów łącznie (limit ustala operator po sprawdzeniu budżetu); ręczne skany Findera zużywają ten sam budżet. Termin, którego nie dało się zlecić w czasie tolerancji, jest pomijany — bez nadrabiania.";

function intervalLabel(minutes: number): string {
  return minutes === 720 ? "12 h (2× dziennie)" : `${minutes / 60} h`;
}

function automationText(automation: ScheduleStatus["automation"]): string {
  if (!automation || !automation.available) return "niedostępne (migracja niezastosowana)";
  const last = automation.recentJobs[0];
  const lastText = last ? `; ostatnie zadanie: ${last.status}${last.errorCode ? ` (${last.errorCode})` : ""}, ${formatDate(last.createdAt)}${last.workerId ? `, ${last.workerId}` : ""}` : "; brak zadań automatycznych";
  return `${automation.enabled ? "WŁĄCZONE" : "WYŁĄCZONE (STOP)"}${lastText}`;
}

function lastSlotText(slot: LastSlot | null | undefined): string {
  if (!slot || !slot.slotAt) return "—";
  if (slot.status === "missed") return `${formatDate(slot.slotAt)} — pominięty (${REASONS[slot.reason ?? ""] ?? slot.reason ?? "brak powodu"})`;
  const actual = slot.startedAt ? `rzeczywisty start ${formatDate(slot.startedAt)} (opóźnienie ${formatDelay(slot.delaySeconds)})` : "jeszcze nie odebrany przez Workera";
  const job = slot.jobStatus ? `, zadanie: ${slot.jobStatus}${slot.jobErrorCode ? ` (${slot.jobErrorCode})` : ""}` : "";
  return `planowany ${formatDate(slot.slotAt)}; ${actual}${job}`;
}

function budgetText(budget: ScheduleStatus["browserBudget"]): string {
  if (!budget) return "brak raportu Workera z dziś (UTC)";
  const seconds = (value: number | null) => value === null ? "?" : `${Math.round(value / 1000)} s`;
  return `zużyto ${seconds(budget.accountBrowserMs)} z ${seconds(budget.safeBudgetMs)}, zostało ${seconds(budget.remainingMs)}, koszt zadania ~${seconds(budget.jobEstimateMs)} — ${budget.fitsOneJob ? "starczy na kolejne" : "NIE starczy na kolejne"}`;
}

function formatDelay(seconds: number | null): string {
  if (seconds === null) return "?";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("pl-PL", { timeZone: FINDER_OLX_TIME_ZONE });
}

export function OlxScheduleField({ filterId, value, startTime, onChange, onStartTimeChange }: { filterId?: string; value: number | null | undefined; startTime?: string | null; onChange: (value: number) => void; onStartTimeChange?: (value: string) => void }) {
  const [status, setStatus] = useState<ScheduleStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    if (!filterId) return;
    fetch(`/api/flip-finder/search-filters/${filterId}/olx-schedule`, { cache: "no-store" })
      .then(async (response) => { const data: unknown = await response.json(); if (!response.ok) throw new Error("Nie udało się odczytać harmonogramu OLX."); return data as ScheduleStatus; })
      .then(setStatus)
      .catch((reason: unknown) => setStatusError(reason instanceof Error ? reason.message : "Nie udało się odczytać harmonogramu OLX."));
  }, [filterId]);
  const selected = value ?? FINDER_OLX_DEFAULT_INTERVAL_MINUTES;
  const selectedTime = startTime ?? FINDER_OLX_DEFAULT_START_TIME;
  const reason = status?.reason === "SLOT_ALREADY_HANDLED" || status?.reason === "BEFORE_FIRST_SLOT" ? null : status?.reason;
  return (
    <div className="space-y-2 sm:col-span-2" data-testid="olx-schedule-field">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="olx-interval">Interwał OLX</Label>
          <select id="olx-interval" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" value={selected} onChange={(event) => onChange(Number(event.target.value))}>
            {FINDER_OLX_INTERVAL_OPTIONS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{intervalLabel(minutes)}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="olx-start-time">Godzina startu OLX (czas polski)</Label>
          <select id="olx-start-time" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" value={selectedTime} onChange={(event) => onStartTimeChange?.(event.target.value)}>
            {FINDER_OLX_START_TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{OLX_CLOUDFLARE_LIMIT_TEXT}</p>
      {selected === 720 ? <p className="text-xs text-amber-700 dark:text-amber-300">12 h działa tylko po podniesieniu globalnego limitu do 2 skanów na 24 h (po weryfikacji budżetu Cloudflare); inaczej drugi termin dnia jest pomijany z czytelnym powodem.</p> : null}
      {statusError ? <p className="text-xs text-destructive">{statusError}</p> : null}
      {status ? (
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="olx-schedule-status">
          <dt className="text-muted-foreground">Ostatni termin</dt><dd>{lastSlotText(status.schedule?.lastSlot)}</dd>
          <dt className="text-muted-foreground">Następny termin</dt><dd>{status.decision === "due" ? "teraz (najbliższe wywołanie harmonogramu)" : formatDate(status.schedule?.nextSlotAt ?? status.nextAllowedAt)}</dd>
          <dt className="text-muted-foreground">Powód pominięcia</dt><dd>{reason ? `${REASONS[reason] ?? reason}${status.nextAllowedAt && reason !== "SLOT_MISSED" ? `; najbliższa możliwość ${formatDate(status.nextAllowedAt)}` : ""}` : "—"}</dd>
          <dt className="text-muted-foreground">Zadania OLX w ostatnich 24 h</dt><dd>{status.budget && status.budget.totalJobs !== null ? `${status.budget.totalJobs} / ${status.budget.sharedLimit} (automatyczne ${status.budget.automaticJobs ?? "?"} / ${status.budget.automaticLimit}, ręczne ${status.budget.finderOtherJobs ?? "?"}, pobrane przez Cloudflare ${status.budget.cloudflareJobs ?? "?"})` : "niedostępne"}</dd>
          <dt className="text-muted-foreground">Budżet przeglądarki Cloudflare (dziś)</dt><dd>{budgetText(status.browserBudget)}</dd>
          <dt className="text-muted-foreground">Status Workera (automat)</dt><dd>{automationText(status.automation)}</dd>
        </dl>
      ) : null}
    </div>
  );
}
