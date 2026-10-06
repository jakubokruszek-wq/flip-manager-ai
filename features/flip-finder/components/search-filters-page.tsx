"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { SearchFilterListItem, SearchFilterListResponse } from "@/features/flip-finder/search-filter-contract";
import { waitUntilScanTerminal } from "@/features/flip-finder/scan-progress-client";

export function SearchFiltersPage() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<SearchFilterListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Cancels only this page's own progress polling on unmount/navigation --
  // the background worker the run id refers to keeps running server-side.
  const pollingAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => pollingAbortRef.current?.abort();
  }, []);
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
    pollingAbortRef.current?.abort();
    pollingAbortRef.current = new AbortController();
    const scanSignal = pollingAbortRef.current.signal;

    try {
      const response = await fetchWithTimeout(`/api/flip-finder/search-filters/${filter.id}/scan`, {
        method: "POST",
        signal: scanSignal,
      }, 20_000);
      const responseData: unknown = await response.json();
      scanSignal.throwIfAborted();

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
        const progress = await waitUntilScanTerminal(start.runId, scanSignal);
        setNotice(
          `Skan zakończony: ${progress.totals.scanned} sprawdzone, ${progress.totals.matched} dopasowanych, ${progress.totals.created} nowych, ${progress.totals.updated} zaktualizowanych, ${progress.totals.priceDrops} obniżek.`,
        );
        await load();
        return;
      }
      setNotice(
        `Skan zakończony: ${start.scannedCount} sprawdzone, ${start.matchedCount} dopasowanych, ${start.newCount} nowych, ${start.updatedCount} zaktualizowanych, ${start.priceDropCount} obniżek.`,
      );
      await load();
    } catch (reason) {
      if (scanSignal.aborted) return;
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

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Uruchomienie skanu przekroczyło limit czasu. Odśwież status przed ponowną próbą.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function message(value: unknown): string {
  return value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? value.message
    : "Nie udało się wykonać operacji.";
}
