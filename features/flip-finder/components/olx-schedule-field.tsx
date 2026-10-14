"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { FINDER_OLX_DEFAULT_INTERVAL_MINUTES, FINDER_OLX_INTERVAL_OPTIONS_MINUTES } from "@/features/flip-finder/finder-schedule";

type ScheduleStatus = {
  decision: "enqueued" | "due" | "skipped";
  reason: string | null;
  lastJobAt: string | null;
  lastJobStatus: string | null;
  lastJobAutomatic: boolean;
  nextAllowedAt: string | null;
  budget: { automaticJobs: number | null; automaticLimit: number; finderOtherJobs: number | null; radarJobs: number | null; cloudflareJobs: number | null; totalJobs: number | null; sharedLimit: number } | null;
};

const REASONS: Record<string, string> = {
  FILTER_INACTIVE: "filtr jest wstrzymany",
  OLX_NOT_SELECTED: "OLX nie jest wybrany w zapisanym filtrze",
  OLX_JOB_IN_FLIGHT: "poprzednie zadanie OLX wciąż czeka lub trwa",
  OLX_INTERVAL_NOT_ELAPSED: "nie minął interwał OLX",
  AUTOMATIC_DAILY_BUDGET_USED: "wykorzystany limit 1 automatycznego skanu OLX na 24 h (wszystkie filtry)",
  SHARED_DAILY_BUDGET_USED: "wykorzystany wspólny budżet OLX na 24 h (ręczne skany, Radar cen)",
  ANOTHER_FILTER_FIRST: "pierwszeństwo ma inny filtr z OLX, który czeka dłużej",
  OLX_INTERVAL_UNAVAILABLE: "interwał OLX niedostępny (migracja niezastosowana)",
  OLX_SCHEDULE_UNAVAILABLE: "harmonogram OLX niedostępny (migracja niezastosowana)",
  OLX_SCHEDULE_CHECK_FAILED: "nie udało się sprawdzić limitu; OLX nie jest zlecany",
};

export const OLX_CLOUDFLARE_LIMIT_TEXT = "OLX jest skanowany osobno od pozostałych portali, przez przeglądarkę Cloudflare (plan Free: 10 minut przeglądarki na dobę dla całego konta). Automatycznie najwyżej 1 skan OLX na 24 h dla wszystkich filtrów; ręczne skany i Radar cen zużywają ten sam budżet. Krótszy interwał wymaga osobnej konfiguracji budżetu.";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("pl-PL");
}

export function OlxScheduleField({ filterId, value, onChange }: { filterId?: string; value: number | null | undefined; onChange: (value: number) => void }) {
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
  return (
    <div className="space-y-2 sm:col-span-2" data-testid="olx-schedule-field">
      <Label htmlFor="olx-interval">Interwał OLX</Label>
      <select id="olx-interval" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm sm:w-48" value={selected} onChange={(event) => onChange(Number(event.target.value))}>
        {FINDER_OLX_INTERVAL_OPTIONS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{minutes / 60} h</option>)}
      </select>
      <p className="text-xs text-muted-foreground">{OLX_CLOUDFLARE_LIMIT_TEXT}</p>
      {statusError ? <p className="text-xs text-destructive">{statusError}</p> : null}
      {status ? (
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="olx-schedule-status">
          <dt className="text-muted-foreground">Ostatnie zlecenie OLX</dt><dd>{formatDate(status.lastJobAt)}{status.lastJobStatus ? ` (${status.lastJobStatus}${status.lastJobAutomatic ? ", automatyczne" : ""})` : ""}</dd>
          <dt className="text-muted-foreground">Następny dopuszczalny termin</dt><dd>{status.decision === "due" ? "teraz (najbliższe wywołanie harmonogramu)" : formatDate(status.nextAllowedAt)}</dd>
          <dt className="text-muted-foreground">Powód pominięcia</dt><dd>{status.reason ? REASONS[status.reason] ?? status.reason : "—"}</dd>
          <dt className="text-muted-foreground">Zadania OLX w ostatnich 24 h</dt><dd>{status.budget && status.budget.totalJobs !== null ? `${status.budget.totalJobs} / ${status.budget.sharedLimit} (automatyczne ${status.budget.automaticJobs ?? "?"} / ${status.budget.automaticLimit}, ręczne ${status.budget.finderOtherJobs ?? "?"}, Radar ${status.budget.radarJobs ?? "?"}, pobrane przez Cloudflare ${status.budget.cloudflareJobs ?? "?"})` : "niedostępne"}</dd>
          <dt className="text-muted-foreground">Czas przeglądarki Cloudflare</dt><dd>niedostępny w aplikacji (licznik w workerze Cloudflare, /status)</dd>
        </dl>
      ) : null}
    </div>
  );
}
