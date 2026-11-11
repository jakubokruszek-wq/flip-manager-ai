"use client";
import { useEffect, useRef, useState } from "react";

/** Bounded live capture stays in this page; no external Android camera activity. */
export default function InAppCamera({ onPhoto, onClose }: { onPhoto: (file: File) => Promise<void>; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const active = useRef(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  function stop() { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (video.current) video.current.srcObject = null; }
  useEffect(() => {
    let disposed = false;
    active.current = true; closeButton.current?.focus();
    const open = async () => { if (!navigator.mediaDevices?.getUserMedia) throw new Error("CAMERA_UNAVAILABLE"); return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1600, max: 1920 }, height: { ideal: 1200, max: 1440 } } }); };
    void open().then(async camera => {
      if (disposed || !active.current || document.visibilityState === "hidden") { camera.getTracks().forEach(track => track.stop()); return; }
      stream.current = camera;
      if (video.current) { video.current.srcObject = camera; try { await video.current.play(); } catch { stop(); if (active.current) setError("Nie udało się uruchomić podglądu. Zamknij aparat i spróbuj ponownie."); } }
    }).catch(() => { if (active.current) setError("Nie udało się otworzyć aparatu. Zezwól na aparat dla Flip Managera albo wybierz aparat systemowy / zdjęcie z telefonu."); });
    const hidden = () => { if (document.visibilityState === "hidden") { stop(); setReady(false); setError("Aparat zatrzymany po opuszczeniu aplikacji. Zamknij ten podgląd i otwórz go ponownie."); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { disposed = true; active.current = false; stop(); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  async function capture() {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight || busy) return;
    setBusy(true); setError("");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(source.videoWidth, source.videoHeight));
    canvas.width = Math.max(1, Math.round(source.videoWidth * scale)); canvas.height = Math.max(1, Math.round(source.videoHeight * scale));
    try {
      const context = canvas.getContext("2d"); if (!context) throw new Error("Nie udało się przygotować zdjęcia.");
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("Nie udało się zapisać zdjęcia. Spróbuj ponownie.");
      if (!active.current) return;
      stop(); canvas.width = 0; canvas.height = 0;
      await onPhoto(new File([blob], `zdjecie-${Date.now()}.jpg`, { type: "image/jpeg" }));
      onClose();
    } catch (caught) { if (active.current) { setError(caught instanceof Error ? caught.message : "Nie udało się zapisać zdjęcia."); setBusy(false); } }
    finally { canvas.width = 0; canvas.height = 0; }
  }
  return <div className="space-y-3 rounded-2xl border border-primary/40 bg-background p-3" role="region" aria-label="Aparat w aplikacji" onKeyDown={event => { if (event.key === "Escape" && !busy) onClose(); }}>
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Aparat w aplikacji</h3><button ref={closeButton} type="button" disabled={busy} onClick={onClose} className="min-h-11 px-3 text-primary underline">Zamknij aparat</button></div>
    <video ref={video} muted playsInline autoPlay aria-label="Podgląd aparatu" onLoadedData={() => setReady(true)} className="aspect-[4/3] max-h-[55svh] w-full rounded-xl bg-black object-contain" />
    {error ? <p role="alert" className="text-sm text-amber-400">{error}</p> : null}
    <button type="button" disabled={!ready || busy || !!error} onClick={() => void capture()} className="min-h-12 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Zapisywanie zdjęcia…" : "Zrób i zapisz zdjęcie"}</button>
    <p className="text-xs text-muted-foreground">Sprawdź ostrość. Zdjęcie zapisze się w tej nieruchomości; aparat wyłączy się po wykonaniu zdjęcia.</p>
  </div>;
}
