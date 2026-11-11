"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { inputClass } from "./ui";
/** Keep the native camera gesture synchronous; release gallery surfaces before Android opens a picker. */
export function AttachmentPicker({ label, cameraLabel, disabled, multiple = false, pdf = false, onFiles, onPicking }: { label: string; cameraLabel: string; disabled: boolean; multiple?: boolean; pdf?: boolean; onFiles: (files: File[]) => Promise<void>; onPicking?: (active: boolean) => void }) {
  const id = useId(); const camera = useRef<HTMLInputElement>(null); const gallery = useRef<HTMLInputElement>(null); const [picking, setPicking] = useState(false);
  const end = useCallback(() => { setPicking(false); onPicking?.(false); }, [onPicking]);
  useEffect(() => { const inputs = [camera.current, gallery.current]; for (const input of inputs) input?.addEventListener("cancel", end); return () => { for (const input of inputs) input?.removeEventListener("cancel", end); }; }, [end]);
  const receive = async (input: HTMLInputElement) => { const files = Array.from(input.files ?? []); input.value = ""; try { if (files.length) await onFiles(files); } finally { end(); } };
  return <div className="space-y-3"><button type="button" disabled={disabled || picking} className="min-h-12 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 font-semibold text-primary disabled:opacity-50" onClick={() => { flushSync(() => { setPicking(true); onPicking?.(true); }); camera.current?.click(); }}>{cameraLabel}</button><input ref={camera} aria-label={`${cameraLabel} — aparat`} className="sr-only" type="file" accept="image/*" capture="environment" disabled={disabled} onChange={e => void receive(e.currentTarget)} /><label htmlFor={id} className="block space-y-2"><span className="block text-sm text-muted-foreground">{label}</span><input ref={gallery} id={id} aria-label={label} className={inputClass} type="file" accept={`image/jpeg,image/png,image/webp${pdf ? ",application/pdf" : ""}`} multiple={multiple} disabled={disabled} onClick={() => { flushSync(() => { setPicking(true); onPicking?.(true); }); }} onChange={e => void receive(e.currentTarget)} /></label>{picking ? <p className="text-xs text-muted-foreground">Otwarto aparat lub wybór plików. Podglądy zdjęć są chwilowo zwolnione.</p> : null}</div>;
}
