"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { SearchFilterListItem, SearchFilterListResponse } from "@/features/flip-finder/search-filter-contract";

export function SearchFiltersPage() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<SearchFilterListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recalculationNotice = useMemo(() => {
    const created = searchParams.get("mode") === "created";

    if (searchParams.get("recalculation") === "failed") {
      return created
        ? "Filtr utworzono, ale nie udało się przeliczyć wyników."
        : "Filtr zapisano, ale nie udało się odświeżyć wyników.";
    }

    if (searchParams.get("recalculated") !== "1") {
      return null;
    }

    const added = searchParams.get("added") ?? "0";
    const removed = searchParams.get("removed") ?? "0";
    return created
      ? `Filtr zapisany — wyniki przeliczone. Dopasowano ${added} ofert.`
      : `Filtr zapisany — wyniki przeliczone. Dodano ${added} dopasowań, usunięto ${removed}.`;
  }, [searchParams]);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/flip-finder/search-filters");
      const responseData: unknown = await response.json();

      if (!response.ok) {
        throw new Error(message(responseData));
      }

      setData(responseData as SearchFilterListResponse);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się pobrać filtrów.");
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const scan = async (filter: SearchFilterListItem) => {
    setScanning(filter.id);
    setError(null);

    try {
      const response = await fetchWithTimeout(`/api/flip-finder/search-filters/${filter.id}/scan`, {
        method: "POST",
      }, 20_000);
      const responseData: unknown = await response.json();

      if (response.status === 429) {
        throw new Error("Skan tego filtra już trwa.");
      }

      if (!response.ok) {
        throw new Error(message(responseData));
      }

      const start = responseData as {
        runId?: string;
        status?: string;
        scannedCount: number;
        matchedCount: number;
        newCount: number;
        updatedCount: number;
        priceDropCount: number;
      };
      if (start.status === "running" && typeof start.runId === "string") {
        setNotice("Skan uruchomiony. Odczytuję postęp z backendu…");
        const summary = await waitForScan(start.runId);
        setNotice(
          `Skan zakończony: ${summary.scannedCount} sprawdzone, ${summary.matchedCount} dopasowanych, ${summary.newCount} nowych, ${summary.updatedCount} zaktualizowanych, ${summary.priceDropCount} obniżek.`,
        );
        await load();
        return;
      }
      setNotice(
        `Skan zakończony: ${start.scannedCount} sprawdzone, ${start.matchedCount} dopasowanych, ${start.newCount} nowych, ${start.updatedCount} zaktualizowanych, ${start.priceDropCount} obniżek.`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się wykonać skanu.");
    } finally {
      setScanning(null);
    }
  };

  if (error && !data) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  if (!data) {
    return <p>Ładowanie filtrów…</p>;
  }

  return (
    <div className="space-y-4">
      {notice ?? recalculationNotice ? <p className="text-sm">{notice ?? recalculationNotice}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {data.filters.map((filter) => (
        <article key={filter.id} className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="font-semibold">{filter.name}</h2>
          <div className="flex flex-wrap gap-2">
            <Button nativeButton={false} render={<Link href={`/flip-finder/filters/${filter.id}/results`} />}>
              Otwórz wyniki
            </Button>
            <Button nativeButton={false} render={<Link href={`/flip-finder/filters/${filter.id}/edit`} />}>
              Edytuj
            </Button>
            <Button disabled={scanning === filter.id} onClick={() => void scan(filter)}>
              {scanning === filter.id ? "Skanowanie…" : "Uruchom skan"}
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

type ScanTotals = { scannedCount: number; matchedCount: number; newCount: number; updatedCount: number; priceDropCount: number };

async function waitForScan(runId: string): Promise<ScanTotals> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    const response = await fetch(`/api/flip-finder/scans/${runId}`, { cache: "no-store" });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(message(value));
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const status = item.status;
    if (status !== "completed" && status !== "partial" && status !== "failed") continue;
    const totals = item.totals && typeof item.totals === "object" ? item.totals as Record<string, unknown> : {};
    return {
      scannedCount: number(totals.scanned),
      matchedCount: number(totals.matched),
      newCount: number(totals.created),
      updatedCount: number(totals.updated),
      priceDropCount: number(totals.priceDrops),
    };
  }
  throw new Error("Skan nie zakończył się w oczekiwanym czasie. Sprawdź jego status przed ponowną próbą.");
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Uruchomienie skanu przekroczyło limit czasu. Odśwież status przed ponowną próbą.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }

function message(value: unknown): string {
  return value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? value.message
    : "Nie udało się wykonać operacji.";
}
