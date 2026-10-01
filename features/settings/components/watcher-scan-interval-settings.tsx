"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_WATCHER_SCAN_INTERVAL_MINUTES,
  MAX_WATCHER_SCAN_INTERVAL_MINUTES,
  MIN_WATCHER_SCAN_INTERVAL_MINUTES,
  WATCHER_SCAN_INTERVAL_PRESETS,
} from "@/features/facebook-worker/scheduler-settings-contract";

export function WatcherScanIntervalSettings() {
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_WATCHER_SCAN_INTERVAL_MINUTES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/facebook-watcher/scheduler-settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || typeof body.intervalMinutes !== "number") throw new Error("Nie udało się pobrać interwału skanów Watchera.");
        if (active) setIntervalMinutes(body.intervalMinutes);
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Nie udało się pobrać interwału skanów Watchera."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/facebook-watcher/scheduler-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalMinutes }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.intervalMinutes !== "number") throw new Error(body.code === "WATCHER_SCAN_INTERVAL_NO_ACTIVE_FILTER" ? "Brak aktywnego filtra Facebooka dla schedulera." : "Nie udało się zapisać interwału skanów Watchera.");
      setIntervalMinutes(body.intervalMinutes);
      setMessage("Interwał zapisany. Scheduler użyje go przy następnym cyklu Watchera.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Nie udało się zapisać interwału skanów Watchera.");
    } finally { setSaving(false); }
  };

  return <section className="ui-section" data-testid="watcher-scan-interval-settings">
    <div>
      <h2 className="type-section-title">Watcher Facebooka</h2>
      <p className="mt-1 text-sm text-muted-foreground">Globalny czas pomiędzy kolejnymi cyklami skanowania. Dotyczy wszystkich aktywnych źródeł Watchera, bez ustawień per grupa.</p>
    </div>
    <div className="mt-5 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">Czas między skanami (minuty)
        <input aria-label="Czas między skanami Watchera" className="h-11 w-52 rounded-xl border bg-background px-3" list="watcher-scan-interval-presets" min={MIN_WATCHER_SCAN_INTERVAL_MINUTES} max={MAX_WATCHER_SCAN_INTERVAL_MINUTES} step="1" type="number" value={intervalMinutes} disabled={loading || saving} onChange={(event) => setIntervalMinutes(Number(event.target.value))} />
        <datalist id="watcher-scan-interval-presets">{WATCHER_SCAN_INTERVAL_PRESETS.map((value) => <option key={value} value={value}>{value} min</option>)}</datalist>
      </label>
      <Button type="button" disabled={loading || saving} onClick={() => void save()}>{saving ? "Zapisywanie…" : "Zapisz interwał Watchera"}</Button>
    </div>
    {message ? <p className="mt-3 text-sm text-muted-foreground" role="status">{message}</p> : null}
  </section>;
}
