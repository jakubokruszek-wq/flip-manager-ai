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
    if (searchParams.get("recalculation") === "failed") {
      return "Filtr zapisano, ale nie udało się odświeżyć wyników.";
    }

    if (searchParams.get("recalculated") !== "1") {
      return null;
    }

    return `Filtr zaktualizowany. Dodano ${searchParams.get("added") ?? "0"} dopasowań, usunięto ${searchParams.get("removed") ?? "0"}.`;
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
      const response = await fetch(`/api/flip-finder/search-filters/${filter.id}/scan`, {
        method: "POST",
      });
      const responseData: unknown = await response.json();

      if (response.status === 429) {
        throw new Error("Skan tego filtra już trwa.");
      }

      if (!response.ok) {
        throw new Error(message(responseData));
      }

      const summary = responseData as {
        scannedCount: number;
        matchedCount: number;
        newCount: number;
        updatedCount: number;
        priceDropCount: number;
      };
      setNotice(
        `Skan zakończony: ${summary.scannedCount} sprawdzone, ${summary.matchedCount} dopasowanych, ${summary.newCount} nowych, ${summary.updatedCount} zaktualizowanych, ${summary.priceDropCount} obniżek.`,
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

function message(value: unknown): string {
  return value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? value.message
    : "Nie udało się wykonać operacji.";
}
