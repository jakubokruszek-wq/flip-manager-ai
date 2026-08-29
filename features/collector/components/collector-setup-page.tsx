"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

export function CollectorSetupPage() {
  const [deviceName, setDeviceName] = useState("Samsung Jakub");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register(): Promise<void> {
    setError(null); setBusy(true);
    try {
      const challengeResponse = await fetch("/api/collector/pairing/challenge", { method: "POST", credentials: "same-origin" });
      const challenge = await challengeResponse.json() as { challenge?: string; message?: string };
      if (!challengeResponse.ok || !challenge.challenge) throw new Error(challenge.message || "Nie udało się rozpocząć parowania.");
      const installationId = crypto.randomUUID();
      window.postMessage({ type: "FLIP_COLLECTOR_PAIRING_REQUEST", challenge: challenge.challenge, deviceName, installationId }, window.location.origin);
      const result = await waitForPairing();
      if (!result.ok) throw new Error(result.message || "Rozszerzenie nie potwierdziło parowania.");
      setConnected(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nie udało się sparować urządzenia."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-xl space-y-5"><header><h1 className="font-heading text-3xl font-semibold">Połącz Flip Collector</h1><p className="mt-2 text-sm text-muted-foreground">Połączenie odbywa się bezpiecznie w tej przeglądarce.</p></header><section className="space-y-4 rounded-xl border bg-card p-5"><label className="block text-sm">Nazwa urządzenia<input className="mt-1 h-10 w-full rounded-lg border bg-background px-3" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label><Button disabled={!deviceName.trim() || busy || connected} onClick={() => void register()}>{connected ? "Połączono" : busy ? "Łączenie…" : "Połącz collector"}</Button>{error ? <p className="text-sm text-destructive">{error}</p> : null}</section></main>;
}
function waitForPairing(): Promise<{ ok: boolean; message?: string }> { return new Promise((resolve) => { const timeout = window.setTimeout(() => { window.removeEventListener("message", listener); resolve({ ok: false, message: "Nie wykryto rozszerzenia Flip Collector." }); }, 15_000); function listener(event: MessageEvent) { if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "FLIP_COLLECTOR_PAIRING_RESULT") return; window.clearTimeout(timeout); window.removeEventListener("message", listener); resolve({ ok: event.data.ok === true, message: typeof event.data.message === "string" ? event.data.message : undefined }); } window.addEventListener("message", listener); }); }
