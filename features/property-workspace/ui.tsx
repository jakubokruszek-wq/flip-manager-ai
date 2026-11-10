"use client";
import { useEffect, useRef, useState, Children, isValidElement, cloneElement, type ReactElement, type ReactNode } from "react";
import { parseMoney } from "./model";
export const inputClass = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-3 text-base outline-none focus:border-primary";
export function TaskForm({ onAdd }: { onAdd: (title: string, contractor: string, dueDate: string) => Promise<boolean> }) {
  const [title, setTitle] = useState(""); const [contractor, setContractor] = useState(""); const [due, setDue] = useState(""); const [busy, setBusy] = useState(false);
  return <form className="space-y-3" onSubmit={async e => { e.preventDefault(); setBusy(true); try { if (await onAdd(title, contractor, due)) { setTitle(""); setContractor(""); setDue(""); } } finally { setBusy(false); } }}><Field label="Zadanie"><input required maxLength={500} className={inputClass} value={title} onChange={e => setTitle(e.target.value)} /></Field><Field label="Wykonawca i kontakt"><input maxLength={300} className={inputClass} value={contractor} onChange={e => setContractor(e.target.value)} /></Field><Field label="Termin"><input type="date" className={inputClass} value={due} onChange={e => setDue(e.target.value)} /></Field><button disabled={busy} className="min-h-11 rounded-xl border px-4 py-2">Dodaj zadanie i zapisz</button></form>;
}
export function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="ui-card min-w-0 space-y-4 p-4 sm:p-6"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>; }
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-2"><span className="block text-sm text-muted-foreground">{label}</span>{Children.map(children, child => isValidElement(child) && typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type) ? cloneElement(child as ReactElement<{ "aria-label"?: string }>, { "aria-label": label }) : child)}</label>;
}
export function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 break-words font-semibold tabular-nums">{value}</p></div>; }
export function MoneyField({ label, value, onChange }: { label: string; value: number | null; onChange: (cents: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : (value / 100).toFixed(2));
  const [error, setError] = useState("");
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(value === null ? "" : (value / 100).toFixed(2)); }, [value]);
  return <Field label={`${label}, zł`}><input className={inputClass} inputMode="decimal" onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} value={text} aria-invalid={!!error} onChange={e => { setText(e.target.value); try { onChange(parseMoney(e.target.value)); setError(""); } catch { setError("Wpisz poprawną kwotę, np. 1250,50."); } }} />{error ? <span role="alert" className="text-xs text-red-400">{error}</span> : null}</Field>;
}
