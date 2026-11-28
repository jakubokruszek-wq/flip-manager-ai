"use client";

import { useEffect, useState } from "react";
import type { RcnResaleResult } from "./resales";
import { StreetResalesPanel } from "./resales-panel";

export function StreetResalesLoader({ listingId }: { listingId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data?: RcnResaleResult; error?: string } | null>(null);
  const key = `${listingId}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/market-intelligence/${encodeURIComponent(listingId)}/resales`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Nie udało się pobrać historii odsprzedaży.");
        if (active) setState({ key, data });
      })
      .catch((error: unknown) => { if (active && !controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "Nie udało się pobrać historii odsprzedaży." }); });
    return () => { active = false; controller.abort(); };
  }, [listingId, key]);
  const current = state?.key === key ? state : null;
  if (current?.data) return <StreetResalesPanel data={current.data} />;
  return <section aria-label="Historia odsprzedaży na ulicy" className="rounded-2xl border border-border bg-card p-4 sm:p-5"><h3 className="text-base font-bold">Możliwe flipy na tej ulicy</h3><div aria-live="polite" className="mt-3 text-sm text-muted-foreground">{current?.error ? <><p>{current.error}</p><button className="mt-3 min-h-11 rounded-lg border px-3 text-sm font-medium" type="button" onClick={() => setAttempt(value => value + 1)}>Ponów historię odsprzedaży</button></> : <p>Sprawdzanie kolejnych sprzedaży tych samych lokali…</p>}</div></section>;
}
