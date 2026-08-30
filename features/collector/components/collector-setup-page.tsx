"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

type PairingStatus = "CHECKING" | "CONNECTED" | "DISCONNECTED" | "RECONNECT_REQUIRED" | "UNVERIFIED";
type PairingStatusMessage = {
  type: "FLIP_COLLECTOR_STATUS_RESULT";
  status?: PairingStatus;
  label?: string;
  deviceLabel?: string | null;
  lastHeartbeatAt?: string | null;
  lastSuccessfulScanAt?: string | null;
  health?: string | null;
};

const INITIAL_STATUS: PairingStatusMessage = { type: "FLIP_COLLECTOR_STATUS_RESULT", status: "CHECKING", label: "Sprawdzanie połączenia…" };

export function CollectorSetupPage() {
  const [deviceName, setDeviceName] = useState("Samsung Jakub");
  const [pairingStatus, setPairingStatus] = useState<PairingStatusMessage>(INITIAL_STATUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let received = false;
    function statusListener(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "FLIP_COLLECTOR_STATUS_RESULT") return;
      received = true;
      setPairingStatus(normalizeStatusMessage(event.data));
    }
    window.addEventListener("message", statusListener);
    requestStatus();
    const timeout = window.setTimeout(() => {
      if (!received) setPairingStatus({ type: "FLIP_COLLECTOR_STATUS_RESULT", status: "DISCONNECTED", label: "Niepołączono" });
    }, 2_500);
    return () => { window.clearTimeout(timeout); window.removeEventListener("message", statusListener); };
  }, []);

  async function register(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const challengeResponse = await fetch("/api/collector/pairing/challenge", { method: "POST", credentials: "same-origin" });
      const challenge = await challengeResponse.json() as { challenge?: string; message?: string };
      if (!challengeResponse.ok || !challenge.challenge) throw new Error(challenge.message || "Nie udało się rozpocząć parowania.");
      const installationId = crypto.randomUUID();
      window.postMessage({ type: "FLIP_COLLECTOR_PAIRING_REQUEST", challenge: challenge.challenge, deviceName, installationId }, window.location.origin);
      const result = await waitForPairing();
      if (!result.ok) throw new Error(result.message || "Rozszerzenie nie potwierdziło parowania.");
      setPairingStatus({ type: "FLIP_COLLECTOR_STATUS_RESULT", status: "CONNECTED", label: "Połączono" });
      requestStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się sparować urządzenia.");
    } finally {
      setBusy(false);
    }
  }

  const canPair = pairingStatus.status === "DISCONNECTED" || pairingStatus.status === "RECONNECT_REQUIRED";
  return (
    <main className="mx-auto max-w-xl space-y-5">
      <header>
        <h1 className="font-heading text-3xl font-semibold">Połącz Flip Collector</h1>
        <p className="mt-2 text-sm text-muted-foreground">Połączenie odbywa się bezpiecznie w tej przeglądarce.</p>
      </header>
      <section className="space-y-4 rounded-xl border bg-card p-5" aria-live="polite">
        <div>
          <p className="font-medium">{pairingStatus.label || statusLabel(pairingStatus.status)}</p>
          <PairingDetails value={pairingStatus} />
        </div>
        {canPair ? <>
          <label className="block text-sm">Nazwa urządzenia<input className="mt-1 h-10 w-full rounded-lg border bg-background px-3" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <Button disabled={!deviceName.trim() || busy} onClick={() => void register()}>{busy ? "Łączenie…" : pairingStatus.status === "RECONNECT_REQUIRED" ? "Połącz ponownie" : "Połącz collector"}</Button>
        </> : null}
        {pairingStatus.status === "UNVERIFIED" ? <Button variant="outline" disabled={busy} onClick={requestStatus}>Sprawdź ponownie</Button> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </section>
    </main>
  );
}

function PairingDetails({ value }: { value: PairingStatusMessage }) {
  const items = [value.deviceLabel, value.lastHeartbeatAt ? `Last heartbeat: ${formatDate(value.lastHeartbeatAt)}` : null, value.lastSuccessfulScanAt ? `Last successful scan: ${formatDate(value.lastSuccessfulScanAt)}` : null, value.health ? `Health: ${value.health}` : null].filter(Boolean);
  return items.length ? <p className="mt-1 text-sm text-muted-foreground">{items.join(" · ")}</p> : null;
}

function requestStatus(): void { window.postMessage({ type: "FLIP_COLLECTOR_STATUS_REQUEST" }, window.location.origin); }
function statusLabel(status?: PairingStatus): string {
  if (status === "CONNECTED") return "Połączono";
  if (status === "RECONNECT_REQUIRED") return "Wymaga ponownego połączenia";
  if (status === "UNVERIFIED") return "Połączenie niezweryfikowane";
  if (status === "DISCONNECTED") return "Niepołączono";
  return "Sprawdzanie połączenia…";
}
function normalizeStatusMessage(value: PairingStatusMessage): PairingStatusMessage {
  const allowed: PairingStatus[] = ["CONNECTED", "DISCONNECTED", "RECONNECT_REQUIRED", "UNVERIFIED"];
  const status = allowed.includes(value.status as PairingStatus) ? value.status : "UNVERIFIED";
  return { type: "FLIP_COLLECTOR_STATUS_RESULT", status, label: typeof value.label === "string" ? value.label.slice(0, 80) : statusLabel(status), deviceLabel: text(value.deviceLabel), lastHeartbeatAt: iso(value.lastHeartbeatAt), lastSuccessfulScanAt: iso(value.lastSuccessfulScanAt), health: text(value.health) };
}
function waitForPairing(): Promise<{ ok: boolean; message?: string }> { return new Promise((resolve) => { const timeout = window.setTimeout(() => { window.removeEventListener("message", listener); resolve({ ok: false, message: "Nie wykryto rozszerzenia Flip Collector." }); }, 15_000); function listener(event: MessageEvent) { if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "FLIP_COLLECTOR_PAIRING_RESULT") return; window.clearTimeout(timeout); window.removeEventListener("message", listener); resolve({ ok: event.data.ok === true, message: typeof event.data.message === "string" ? event.data.message : undefined }); } window.addEventListener("message", listener); }); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("pl-PL"); }
function iso(value: unknown): string | null { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null; return new Date(value).toISOString(); }
function text(value: unknown): string | null { return typeof value === "string" ? value.slice(0, 100) : null; }
