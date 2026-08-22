"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FacebookGroupCreatePayload } from "../group-url";
import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "../types";

const initial: FacebookGroupCreatePayload = { name: "", url: "", city: "Łódź", priority: "normal", enabled: true };

export function WatchedGroupsPage() {
  const [groups, setGroups] = useState<WatchedFacebookGroup[]>([]);
  const [form, setForm] = useState<FacebookGroupCreatePayload>({ ...initial });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await fetch("/api/facebook-watcher/groups", { cache: "no-store" });
    const body = await response.json() as { groups?: WatchedFacebookGroup[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać grup.");
    setGroups(body.groups ?? []);
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/facebook-watcher/groups", { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json() as { groups?: WatchedFacebookGroup[]; error?: string } }))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać grup.");
        if (active) setGroups(body.groups ?? []);
      })
      .catch((value) => { if (active) setError(value instanceof Error ? value.message : "Nie udało się pobrać grup."); });
    return () => { active = false; };
  }, []);

  const create = async () => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const response = await fetch("/api/facebook-watcher/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const result = await response.json() as AddWatchedFacebookGroupResult;
      if (!response.ok || !result.success) throw new Error(result.success ? "Nie udało się dodać grupy." : result.error);
      setGroups((current) => [...current.filter((item) => item.id !== result.group.id), result.group]);
      setForm({ ...initial });
      setSuccess("Grupa została dodana do obserwowanych.");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Nie udało się dodać grupy.");
    } finally { setBusy(false); }
  };

  const toggle = async (group: WatchedFacebookGroup) => {
    const response = await fetch(`/api/facebook-watcher/groups/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !group.enabled }) });
    const body = await response.json() as { group?: WatchedFacebookGroup; error?: string };
    if (response.ok && body.group) setGroups((current) => current.map((item) => item.id === group.id ? body.group! : item));
    else setError(body.error ?? "Nie udało się zmienić statusu grupy.");
  };

  return <main className="space-y-6">
    <header><p className="text-xs font-bold uppercase tracking-[.16em] text-gold">Facebook Group Watcher</p><h1 className="mt-2 text-3xl font-bold">Obserwowane grupy</h1><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Dodaj publiczny adres grupy. Flip Manager użyje jej automatycznie przy następnym normalnym skanie Facebooka.</p></header>
    <section className="ui-section">
      <h2 className="text-lg font-bold">Dodaj grupę przez link</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field className="sm:col-span-2" label="Facebook group URL" placeholder="https://www.facebook.com/groups/..." value={form.url} onChange={(url) => setForm((value) => ({ ...value, url }))}/>
        <Field label="Name — opcjonalne" placeholder="Facebook group …" value={form.name ?? ""} onChange={(name) => setForm((value) => ({ ...value, name }))}/>
        <Field label="City" value={form.city ?? "Łódź"} onChange={(city) => setForm((value) => ({ ...value, city }))}/>
        <label className="grid gap-1 text-sm">Priority<select className="h-11 rounded-xl border bg-background px-3" value={form.priority} onChange={(event) => setForm((value) => ({ ...value, priority: event.target.value as "normal" | "high" }))}><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border px-3 text-sm"><input checked={form.enabled !== false} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} type="checkbox"/>Enabled</label>
      </div>
      {success ? <p className="mt-3 text-sm text-emerald-400" role="status">{success}</p> : null}
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      <Button className="mt-4 min-h-11" disabled={busy || !form.url.trim()} onClick={() => void create()}><Plus className="size-4"/>{busy ? "Dodawanie…" : "Dodaj grupę"}</Button>
    </section>
    <section className="grid gap-4 lg:grid-cols-2">
      {groups.map((group) => <article className="ui-section" key={group.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">{group.name}</h2><Status value={group.accessStatus}/><span className="rounded-full border px-2 py-1 text-[10px] font-bold uppercase">{group.priority}</span></div><p className="mt-1 text-sm text-muted-foreground">{[group.neighborhood, group.district, group.city].filter(Boolean).join(" • ")}</p><p className="mt-1 break-all text-xs text-muted-foreground">{groupIdentifier(group.url)}</p></div><button aria-label={group.enabled ? "Wstrzymaj grupę" : "Aktywuj grupę"} className="min-h-11 rounded-xl border px-3 text-xs font-bold" onClick={() => void toggle(group)}>{group.enabled ? "Aktywna" : "Wstrzymana"}</button></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><Metric label="Importy" value={group.importedPosts}/><Metric label="Nowe dziś" value={group.newToday}/><Metric label="Okazje" value={group.opportunities}/><Metric label="Ostatnie sprawdzenie" value={group.lastCheckedAt ? new Date(group.lastCheckedAt).toLocaleString("pl-PL") : "—"}/></div>{group.accessStatus !== "CONNECTED" ? <p className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">Grupa oczekuje na sprawdzenie przez lokalny Facebook worker.</p> : null}{group.lastError ? <p className="mt-2 text-xs text-danger">{group.lastError}</p> : null}<div className="mt-3 flex flex-wrap gap-3"><a className="flex min-h-11 items-center gap-2 text-sm font-semibold text-gold" href={group.url} target="_blank" rel="noopener noreferrer">Facebook<ExternalLink className="size-4"/></a><Link className="flex min-h-11 items-center gap-2 text-sm font-semibold" href="/properties/new">Import ręczny</Link></div></article>)}
      {!groups.length ? <div className="ui-section text-sm text-muted-foreground">Nie dodano jeszcze obserwowanych grup.</div> : null}
    </section>
    <Button variant="outline" onClick={() => void load()}><RefreshCw className="size-4"/>Odśwież</Button>
  </main>;
}

function groupIdentifier(value: string) { try { return new URL(value).pathname.match(/^\/groups\/([^/]+)/i)?.[1] ?? value; } catch { return value; } }
function Field({ label, value, onChange, placeholder, className = "" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; className?: string }) { return <label className={`grid gap-1 text-sm ${className}`}>{label}<input className="h-11 rounded-xl border bg-background px-3" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)}/></label>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-bold">{value}</p></div>; }
function Status({ value }: { value: WatchedFacebookGroup["accessStatus"] }) { return <span className="rounded-full bg-gold/10 px-2 py-1 text-[10px] font-bold text-gold">{value}</span>; }
