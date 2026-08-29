"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type Registration = { deviceId: string; deviceToken: string };

export function CollectorSetupPage() {
  const [deviceName, setDeviceName] = useState("Samsung Jakub");
  const [secret, setSecret] = useState("");
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function register(): Promise<void> {
    setError(null); setRegistration(null); setQr(null);
    try {
      const response = await fetch("/api/collector/devices/register", { method: "POST", headers: { "Content-Type": "application/json", "x-flip-collector-pairing-secret": secret }, body: JSON.stringify({ deviceName, installationId: crypto.randomUUID() }) });
      const data: unknown = await response.json();
      if (!response.ok || !isRegistration(data)) throw new Error(message(data));
      setQr(await QRCode.toDataURL(JSON.stringify({ apiUrl: window.location.origin, deviceToken: data.deviceToken, deviceId: data.deviceId }), { errorCorrectionLevel: "M", margin: 1, width: 320 }));
      setRegistration(data); setSecret("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nie udało się sparować urządzenia."); }
  }

  return <main className="mx-auto max-w-xl space-y-5"><header><h1 className="font-heading text-3xl font-semibold">Połącz Flip Collector</h1><p className="mt-2 text-sm text-muted-foreground">Sekret nie jest zapisywany.</p></header>{registration ? <section className="space-y-4 rounded-xl border bg-card p-5"><p className="font-medium">Zeskanuj kod w aplikacji Flip Collector.</p>{qr ? <Image unoptimized alt="Kod QR parowania Flip Collectora" className="mx-auto size-80 max-w-full" height={320} src={qr} width={320} /> : null}<details><summary>Awaryjne ręczne wklejenie danych</summary><p className="mt-2 text-xs text-muted-foreground">Device ID</p><code className="block break-all rounded bg-muted p-3 text-xs">{registration.deviceId}</code><p className="mt-2 text-xs text-muted-foreground">Device token</p><code className="block break-all rounded bg-muted p-3 text-xs">{registration.deviceToken}</code></details></section> : <section className="space-y-4 rounded-xl border bg-card p-5"><label className="block text-sm">Nazwa urządzenia<input className="mt-1 h-10 w-full rounded-lg border bg-background px-3" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label><label className="block text-sm">Sekret parowania<input autoComplete="off" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} /></label><Button disabled={!deviceName.trim() || !secret} onClick={() => void register()}>Wygeneruj kod QR</Button>{error ? <p className="text-sm text-destructive">{error}</p> : null}</section>}</main>;
}
function isRegistration(value: unknown): value is Registration { return value !== null && typeof value === "object" && "deviceId" in value && typeof value.deviceId === "string" && "deviceToken" in value && typeof value.deviceToken === "string"; }
function message(value: unknown): string { return value !== null && typeof value === "object" && "message" in value && typeof value.message === "string" ? value.message : "Nie udało się sparować urządzenia."; }
