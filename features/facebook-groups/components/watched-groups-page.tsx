"use client";

import Link from "next/link";
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FacebookGroupCreatePayload } from "../group-url";
import {
  partitionWatchedFacebookGroups,
  type FacebookGroupManagementPatch,
} from "../management";
import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "../types";

const initial: FacebookGroupCreatePayload = {
  type: "GROUP",
  name: "",
  url: "",
  city: "Łódź",
  priority: "normal",
  enabled: true,
};

export function WatchedGroupsPage() {
  const [groups, setGroups] = useState<WatchedFacebookGroup[]>([]);
  const [form, setForm] = useState<FacebookGroupCreatePayload>({ ...initial });
  const [editing, setEditing] = useState<WatchedFacebookGroup | null>(null);
  const [removing, setRemoving] = useState<WatchedFacebookGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await facebookGroupsFetch("/api/facebook-watcher/groups", { cache: "no-store" });
    const body = (await response.json()) as { groups?: WatchedFacebookGroup[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać grup.");
    setGroups(body.groups ?? []);
  };

  useEffect(() => {
    let active = true;
    void facebookGroupsFetch("/api/facebook-watcher/groups", { cache: "no-store" })
      .then(async (response) => ({
        response,
        body: (await response.json()) as { groups?: WatchedFacebookGroup[]; error?: string },
      }))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać grup.");
        if (active) setGroups(body.groups ?? []);
      })
      .catch((value: unknown) => {
        if (active) setError(errorMessage(value, "Nie udało się pobrać grup."));
      });
    return () => {
      active = false;
    };
  }, []);

  const create = async () => {
    setBusy(true);
    clearFeedback();
    try {
      const response = await facebookGroupsFetch("/api/facebook-watcher/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = (await response.json()) as AddWatchedFacebookGroupResult;
      if (!response.ok || !result.success) {
        throw new Error(result.success ? "Nie udało się dodać grupy." : result.error);
      }
      replaceGroup(result.group);
      setForm({ ...initial });
      setSuccess("Grupa została dodana do obserwowanych.");
    } catch (value) {
      setError(errorMessage(value, "Nie udało się dodać grupy."));
    } finally {
      setBusy(false);
    }
  };

  const update = async (
    group: WatchedFacebookGroup,
    patch: FacebookGroupManagementPatch,
    successMessage: string,
  ) => {
    setBusy(true);
    clearFeedback();
    try {
      const response = await facebookGroupsFetch(`/api/facebook-watcher/groups/${group.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await response.json()) as { group?: WatchedFacebookGroup; error?: string };
      if (!response.ok || !body.group) throw new Error(body.error ?? "Nie udało się zapisać grupy.");
      replaceGroup(body.group);
      setEditing(null);
      setSuccess(successMessage);
    } catch (value) {
      setError(errorMessage(value, "Nie udało się zapisać grupy."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    clearFeedback();
    try {
      const response = await facebookGroupsFetch(`/api/facebook-watcher/groups/${removing.id}`, { method: "DELETE" });
      const body = (await response.json()) as { group?: WatchedFacebookGroup; error?: string };
      if (!response.ok || !body.group) throw new Error(body.error ?? "Nie udało się usunąć grupy.");
      replaceGroup(body.group);
      setRemoving(null);
      setSuccess("Grupa została wyłączona i przeniesiona do nieaktywnych. Historia została zachowana.");
    } catch (value) {
      setError(errorMessage(value, "Nie udało się usunąć grupy."));
    } finally {
      setBusy(false);
    }
  };

  const replaceGroup = (group: WatchedFacebookGroup) => {
    setGroups((current) => [...current.filter((item) => item.id !== group.id), group]);
  };
  const clearFeedback = () => {
    setError(null);
    setSuccess(null);
  };

  const partitioned = partitionWatchedFacebookGroups(groups);

  return (
    <main className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-gold">Facebook Group Watcher</p>
          <h1 className="mt-2 text-3xl font-bold">Obserwowane grupy</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Zarządzaj grupami używanymi automatycznie przy następnym normalnym skanie Facebooka.
          </p>
        </div>
        <Button className="min-h-11" nativeButton={false} render={<Link href="/properties/new" />} variant="outline">
          Import ręczny
        </Button>
      </header>

      <section className="ui-section">
        <h2 className="text-lg font-bold">Dodaj grupę przez link</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-sm">Typ źródła<select className="h-11 rounded-xl border bg-background px-3" value={form.type ?? "GROUP"} onChange={(event) => setForm((value) => ({ ...value, type: event.target.value === "PROFILE" ? "PROFILE" : "GROUP" }))}><option value="GROUP">Grupa</option><option value="PROFILE">Profil</option></select></label>
          <Field className="sm:col-span-2" label={form.type === "PROFILE" ? "Facebook profile URL" : "Facebook group URL"} placeholder={form.type === "PROFILE" ? "https://www.facebook.com/profile.php?id=..." : "https://www.facebook.com/groups/..."} value={form.url} onChange={(url) => setForm((value) => ({ ...value, url }))} />
          <Field label="Nazwa — opcjonalnie" placeholder="Facebook group …" value={form.name ?? ""} onChange={(name) => setForm((value) => ({ ...value, name }))} />
          <Field label="Miasto" value={form.city ?? "Łódź"} onChange={(city) => setForm((value) => ({ ...value, city }))} />
          <label className="grid gap-1 text-sm">Priorytet<SelectPriority value={form.priority ?? "normal"} onChange={(priority) => setForm((value) => ({ ...value, priority: priority === "low" ? "normal" : priority }))} create /></label>
          <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border px-3 text-sm"><input checked={form.enabled !== false} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} type="checkbox" />Aktywna</label>
        </div>
        {success ? <p className="mt-3 text-sm text-emerald-400" role="status">{success}</p> : null}
        {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
        <Button className="mt-4 min-h-11" disabled={busy || !form.url.trim()} onClick={() => void create()}><Plus className="size-4" />{busy ? "Dodawanie…" : "Dodaj grupę"}</Button>
      </section>

      <GroupSection title={`Aktywne grupy (${partitioned.active.length})`} empty="Brak aktywnych grup." groups={partitioned.active} onEdit={setEditing} onRemove={setRemoving} onToggle={(group) => void update(group, groupPatch(group, { enabled: false }), "Grupa została wstrzymana.")} />
      <GroupSection title={`Nieaktywne grupy (${partitioned.inactive.length})`} empty="Brak nieaktywnych grup." groups={partitioned.inactive} onEdit={setEditing} onRemove={setRemoving} onToggle={(group) => void update(group, groupPatch(group, { enabled: true }), "Grupa została aktywowana.")} />

      <Button variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />Odśwież</Button>

      {editing ? <EditDialog busy={busy} group={editing} key={editing.id} onClose={() => setEditing(null)} onSave={(group, patch) => void update(group, patch, "Zmiany grupy zostały zapisane.")} /> : null}
      <Dialog open={Boolean(removing)} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Usunąć grupę z obserwowanych?</DialogTitle>
            <DialogDescription>
              Grupa zostanie wyłączona i nie trafi do kolejnych skanów. Oferty, snapshoty, historia cen, skany, zdjęcia i powiązania źródłowe pozostaną zachowane.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>Anuluj</Button>
            <Button disabled={busy} onClick={() => void remove()}>{busy ? "Usuwanie…" : "Usuń z obserwowanych"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function GroupSection({ title, empty, groups, onToggle, onEdit, onRemove }: { title: string; empty: string; groups: WatchedFacebookGroup[]; onToggle: (group: WatchedFacebookGroup) => void; onEdit: (group: WatchedFacebookGroup) => void; onRemove: (group: WatchedFacebookGroup) => void }) {
  return <section className="space-y-3"><h2 className="text-lg font-bold">{title}</h2><div className="grid gap-4 lg:grid-cols-2">{groups.map((group) => <GroupCard group={group} key={group.id} onToggle={onToggle} onEdit={onEdit} onRemove={onRemove} />)}{!groups.length ? <div className="ui-section text-sm text-muted-foreground">{empty}</div> : null}</div></section>;
}

function GroupCard({ group, onToggle, onEdit, onRemove }: { group: WatchedFacebookGroup; onToggle: (group: WatchedFacebookGroup) => void; onEdit: (group: WatchedFacebookGroup) => void; onRemove: (group: WatchedFacebookGroup) => void }) {
  return <article className="ui-section"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{group.name}</h3><Status value={group.accessStatus} /><span className="rounded-full border px-2 py-1 text-[10px] font-bold uppercase">{group.priority}</span></div><p className="mt-1 text-sm text-muted-foreground">{[group.neighborhood, group.district, group.city].filter(Boolean).join(" • ")}</p><p className="mt-1 break-all text-xs text-muted-foreground">{groupIdentifier(group.url)}</p></div><button aria-label={group.enabled ? "Wstrzymaj grupę" : "Aktywuj grupę"} className="min-h-11 rounded-xl border px-3 text-xs font-bold" onClick={() => onToggle(group)}>{group.enabled ? "Aktywna" : "Wstrzymana"}</button></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><Metric label="Importy" value={group.importedPosts} /><Metric label="Nowe dziś" value={group.newToday} /><Metric label="Okazje" value={group.opportunities} /><Metric label="Ostatnie sprawdzenie" value={group.lastCheckedAt ? new Date(group.lastCheckedAt).toLocaleString("pl-PL") : "—"} /></div>{group.accessStatus !== "CONNECTED" ? <p className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">Grupa oczekuje na sprawdzenie przez lokalny Facebook worker.</p> : null}{group.lastError ? <p className="mt-2 text-xs text-danger">{group.lastError}</p> : null}<div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={() => onEdit(group)}><Pencil className="size-4" />Edytuj</Button><Button variant="outline" className="min-h-11" onClick={() => onRemove(group)}><Trash2 className="size-4" />Usuń</Button><a className="flex min-h-11 items-center gap-2 px-2 text-sm font-semibold text-gold" href={group.url} target="_blank" rel="noopener noreferrer">Facebook<ExternalLink className="size-4" /></a></div></article>;
}

function EditDialog({ group, busy, onClose, onSave }: { group: WatchedFacebookGroup; busy: boolean; onClose: () => void; onSave: (group: WatchedFacebookGroup, patch: FacebookGroupManagementPatch) => void }) {
  const [draft, setDraft] = useState<FacebookGroupManagementPatch>(() => groupPatch(group));
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Edytuj grupę</DialogTitle><DialogDescription>Zmiany będą użyte automatycznie przy następnym skanie. Adres i identyfikator grupy są niezmienne.</DialogDescription></DialogHeader><div className="grid gap-3"><Field label="Nazwa" value={draft.name} onChange={(name) => setDraft((value) => value ? { ...value, name } : value)} /><Field label="Miasto" value={draft.city} onChange={(city) => setDraft((value) => value ? { ...value, city } : value)} /><label className="grid gap-1 text-sm">Priorytet<SelectPriority value={draft.priority} onChange={(priority) => setDraft((value) => value ? { ...value, priority } : value)} /></label><label className="flex min-h-11 items-center gap-3 rounded-xl border px-3 text-sm"><input checked={draft.enabled} onChange={(event) => setDraft((value) => value ? { ...value, enabled: event.target.checked } : value)} type="checkbox" />Aktywna</label><Field disabled label="Facebook group URL (tylko do odczytu)" value={group.url} onChange={() => undefined} /><Field disabled label="Identyfikator (tylko do odczytu)" value={groupIdentifier(group.url)} onChange={() => undefined} /></div><DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Anuluj</Button><Button disabled={busy || !draft.name.trim() || !draft.city.trim()} onClick={() => onSave(group, draft)}>{busy ? "Zapisywanie…" : "Zapisz"}</Button></DialogFooter></DialogContent></Dialog>;
}

function groupPatch(group: WatchedFacebookGroup, patch: Partial<FacebookGroupManagementPatch> = {}): FacebookGroupManagementPatch { return { name: group.name, city: group.city ?? "", priority: group.priority, enabled: group.enabled, ...patch }; }
function groupIdentifier(value: string) { try { return new URL(value).pathname.match(/^\/groups\/([^/]+)/i)?.[1] ?? value; } catch { return value; } }
async function facebookGroupsFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return apiFetch(input, init);
}
function errorMessage(value: unknown, fallback: string) { return value instanceof Error ? value.message : fallback; }
function Field({ label, value, onChange, placeholder, className = "", disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; className?: string; disabled?: boolean }) { return <label className={`grid gap-1 text-sm ${className}`}>{label}<input className="h-11 rounded-xl border bg-background px-3 disabled:cursor-not-allowed disabled:opacity-70" disabled={disabled} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function SelectPriority({ value, onChange, create = false }: { value: "high" | "normal" | "low"; onChange: (value: "high" | "normal" | "low") => void; create?: boolean }) { return <select className="h-11 rounded-xl border bg-background px-3" value={value} onChange={(event) => onChange(event.target.value as "high" | "normal" | "low")}><option value="normal">Normal</option><option value="high">High</option>{create ? null : <option value="low">Low</option>}</select>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-bold">{value}</p></div>; }
function Status({ value }: { value: WatchedFacebookGroup["accessStatus"] }) { return <span className="rounded-full bg-gold/10 px-2 py-1 text-[10px] font-bold text-gold">{value}</span>; }
