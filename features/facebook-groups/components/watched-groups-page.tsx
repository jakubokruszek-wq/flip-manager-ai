"use client";

import Link from "next/link";
import { ExternalLink, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
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
import type { FacebookGroupImportPreviewItem, HistoricalFacebookSourceMapping } from "../discovery";
import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "../types";
import { resolveFacebookGroupDisplayName } from "../display-name";

const IMPORTABLE_STATUSES = new Set<FacebookGroupImportPreviewItem["status"]>(["NOWA", "MOZLIWY_DUPLIKAT"]);

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
  const [preview, setPreview] = useState<FacebookGroupImportPreviewItem[]>([]);
  const [previewExpiresAt, setPreviewExpiresAt] = useState<string | null>(null);
  const [discoveryToken, setDiscoveryToken] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewNames, setPreviewNames] = useState<Record<string, string>>({});
  const [historicalMapping, setHistoricalMapping] = useState<HistoricalFacebookSourceMapping[]>([]);

  const load = async () => {
    const response = await facebookGroupsFetch("/api/facebook-watcher/groups", { cache: "no-store" });
    const body = (await response.json()) as { groups?: WatchedFacebookGroup[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać grup.");
    setGroups(body.groups ?? []);
  };

  // The extension hands off a discovery session as an opaque token in the
  // URL FRAGMENT (never a query parameter, so it is never sent in the
  // initial request, a Referer header, or normal server access logs) --
  // read only client-side, then sent in a POST body to actually retrieve
  // the preview. The fragment is cleared immediately after reading it so a
  // page refresh never re-sends an already-used or expired token.
  const loadDiscoveryPreviewForToken = async (token: string) => {
    const response = await facebookGroupsFetch("/api/facebook-watcher/groups/discover/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    const body = (await response.json()) as { preview?: FacebookGroupImportPreviewItem[]; expiresAt?: string; error?: string };
    if (!response.ok) {
      setDiscoveryToken(null);
      setDiscoveryError(body.error ?? "Token wykrywania grup jest nieprawidłowy lub wygasł. Uruchom wykrywanie ponownie z rozszerzenia.");
      return;
    }
    const items = body.preview ?? [];
    setDiscoveryToken(token);
    setDiscoveryError(null);
    setPreview(items);
    setPreviewExpiresAt(body.expiresAt ?? null);
    setPreviewNames(Object.fromEntries(items.map((item) => [item.url, item.discoveredName ?? ""])));
  };

  const loadHistoricalMapping = async () => {
    const response = await facebookGroupsFetch("/api/facebook-watcher/groups/historical-mapping", { cache: "no-store" });
    const body = (await response.json()) as { mapping?: HistoricalFacebookSourceMapping[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać mapowania historycznych źródeł.");
    setHistoricalMapping(body.mapping ?? []);
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
    const hashToken = readDiscoveryTokenFromHash();
    if (hashToken) {
      clearDiscoveryHash();
      void facebookGroupsFetch("/api/facebook-watcher/groups/discover/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: hashToken }),
        cache: "no-store",
      })
        .then(async (response) => ({ response, body: (await response.json()) as { preview?: FacebookGroupImportPreviewItem[]; expiresAt?: string; error?: string } }))
        .then(({ response, body }) => {
          if (!active) return;
          if (!response.ok) { setDiscoveryError(body.error ?? "Token wykrywania grup jest nieprawidłowy lub wygasł. Uruchom wykrywanie ponownie z rozszerzenia."); return; }
          const items = body.preview ?? [];
          setDiscoveryToken(hashToken);
          setPreview(items);
          setPreviewExpiresAt(body.expiresAt ?? null);
          setPreviewNames(Object.fromEntries(items.map((item) => [item.url, item.discoveredName ?? ""])));
        })
        .catch((value: unknown) => {
          if (active) setDiscoveryError(errorMessage(value, "Nie udało się pobrać wyników wykrywania grup."));
        });
    }
    void facebookGroupsFetch("/api/facebook-watcher/groups/historical-mapping", { cache: "no-store" })
      .then(async (response) => ({ response, body: (await response.json()) as { mapping?: HistoricalFacebookSourceMapping[]; error?: string } }))
      .then(({ response, body }) => {
        if (response.ok && active) setHistoricalMapping(body.mapping ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const toggleSelected = (url: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  };

  const importSelected = async () => {
    if (!discoveryToken) {
      setError("Brak aktywnej sesji wykrywania — uruchom wykrywanie ponownie z rozszerzenia.");
      return;
    }
    const selections = preview
      .filter((item) => selected.has(item.url) && IMPORTABLE_STATUSES.has(item.status))
      .map((item) => ({ url: item.url, name: (previewNames[item.url] ?? item.discoveredName ?? "").trim() }));
    if (!selections.length) {
      setError("Wybierz co najmniej jedną grupę do zaimportowania.");
      return;
    }
    if (selections.some((selection) => !selection.name)) {
      setError("Nazwa grupy jest wymagana dla każdego wyboru — uzupełnij ją przed importem.");
      return;
    }
    setBusy(true);
    clearFeedback();
    try {
      const response = await facebookGroupsFetch("/api/facebook-watcher/groups/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: discoveryToken, selections }),
      });
      const body = (await response.json()) as { outcomes?: Array<{ url: string; result: AddWatchedFacebookGroupResult }>; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Nie udało się zaimportować wybranych grup.");
      const outcomes = body.outcomes ?? [];
      for (const outcome of outcomes) if (outcome.result.success) replaceGroup(outcome.result.group);
      const failed = outcomes.filter((outcome) => !outcome.result.success);
      setSelected(new Set());
      await load();
      if (failed.length) {
        setError(`${outcomes.length - failed.length} z ${outcomes.length} grup zaimportowano. Błędy: ${failed.map((item) => item.result.success ? "" : item.result.error).join("; ")}`);
      } else {
        setSuccess(`Zaimportowano ${outcomes.length} ${outcomes.length === 1 ? "grupę" : "grup"}.`);
      }
    } catch (value) {
      setError(errorMessage(value, "Nie udało się zaimportować wybranych grup."));
    } finally {
      setBusy(false);
    }
  };

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
          <Field label="Nazwa grupy" placeholder="np. Łódź Sprzedaż Zakup Wynajem" value={form.name ?? ""} onChange={(name) => setForm((value) => ({ ...value, name }))} />
          <Field label="Miasto" value={form.city ?? "Łódź"} onChange={(city) => setForm((value) => ({ ...value, city }))} />
          <label className="grid gap-1 text-sm">Priorytet<SelectPriority value={form.priority ?? "normal"} onChange={(priority) => setForm((value) => ({ ...value, priority: priority === "low" ? "normal" : priority }))} create /></label>
          <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border px-3 text-sm"><input checked={form.enabled !== false} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} type="checkbox" />Aktywna</label>
        </div>
        {success ? <p className="mt-3 text-sm text-emerald-400" role="status">{success}</p> : null}
        {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
        <Button className="mt-4 min-h-11" disabled={busy || !form.url.trim() || !form.name?.trim()} onClick={() => void create()}><Plus className="size-4" />{busy ? "Dodawanie…" : "Dodaj grupę"}</Button>
      </section>

      <DiscoverySection
        preview={preview}
        previewExpiresAt={previewExpiresAt}
        discoveryToken={discoveryToken}
        discoveryError={discoveryError}
        previewNames={previewNames}
        onNameChange={(url, name) => setPreviewNames((current) => ({ ...current, [url]: name }))}
        selected={selected}
        onToggleSelected={toggleSelected}
        busy={busy}
        onRefresh={discoveryToken ? () => void loadDiscoveryPreviewForToken(discoveryToken).catch((value: unknown) => setDiscoveryError(errorMessage(value, "Nie udało się pobrać wyników wykrywania grup."))) : undefined}
        onImport={() => void importSelected()}
      />

      <GroupSection title={`Aktywne grupy (${partitioned.active.length})`} empty="Brak aktywnych grup." groups={partitioned.active} onEdit={setEditing} onRemove={setRemoving} onToggle={(group) => void update(group, groupPatch(group, { enabled: false }), "Grupa została wstrzymana.")} />
      <GroupSection title={`Nieaktywne grupy (${partitioned.inactive.length})`} empty="Brak nieaktywnych grup." groups={partitioned.inactive} onEdit={setEditing} onRemove={setRemoving} onToggle={(group) => void update(group, groupPatch(group, { enabled: true }), "Grupa została aktywowana.")} />

      <Button variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />Odśwież</Button>

      <HistoricalMappingSection mapping={historicalMapping} onRefresh={() => void loadHistoricalMapping().catch((value: unknown) => setError(errorMessage(value, "Nie udało się pobrać mapowania historycznych źródeł.")))} />

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

function DiscoverySection({ preview, previewExpiresAt, discoveryToken, discoveryError, previewNames, onNameChange, selected, onToggleSelected, busy, onRefresh, onImport }: {
  preview: FacebookGroupImportPreviewItem[];
  previewExpiresAt: string | null;
  discoveryToken: string | null;
  discoveryError: string | null;
  previewNames: Record<string, string>;
  onNameChange: (url: string, name: string) => void;
  selected: Set<string>;
  onToggleSelected: (url: string) => void;
  busy: boolean;
  onRefresh?: () => void;
  onImport: () => void;
}) {
  const selectableCount = preview.filter((item) => IMPORTABLE_STATUSES.has(item.status)).length;
  const selectedCount = preview.filter((item) => selected.has(item.url) && IMPORTABLE_STATUSES.has(item.status)).length;
  return (
    <section className="ui-section space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Wykryj grupy nieruchomościowe</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Kliknij &quot;Wykryj grupy nieruchomościowe&quot; w rozszerzeniu Facebook Collector (na stronie Twoich grup na Facebooku) — rozszerzenie otworzy tę stronę z wynikami automatycznie. Nazwa każdej grupy pochodzi z tego, co rozszerzenie faktycznie odczytało na Facebooku, nigdy z domysłu ani ze zrzutu ekranu.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            nativeButton={false}
            render={<a href="https://www.facebook.com/groups/joins/" target="_blank" rel="noopener noreferrer" />}
          >
            <Search className="size-4" />Otwórz Twoje grupy na Facebooku
          </Button>
          {onRefresh ? <Button variant="outline" className="min-h-11" onClick={onRefresh}><RefreshCw className="size-4" />Odśwież podgląd</Button> : null}
        </div>
      </div>
      {discoveryError ? <p className="text-sm text-danger" role="alert">{discoveryError}</p> : null}
      {!discoveryToken && !discoveryError ? <p className="text-xs text-muted-foreground">Brak aktywnej sesji wykrywania. Uruchom &quot;Wykryj grupy nieruchomościowe&quot; z rozszerzenia na Facebooku.</p> : null}
      {discoveryToken && previewExpiresAt ? <p className="text-xs text-muted-foreground">Sesja wykrywania wygasa: {new Date(previewExpiresAt).toLocaleString("pl-PL")}</p> : null}
      {preview.length ? (
        <div className="space-y-2">
          {preview.map((item) => (
            <ImportPreviewRow
              key={item.url}
              item={item}
              name={previewNames[item.url] ?? ""}
              onNameChange={(name) => onNameChange(item.url, name)}
              checked={selected.has(item.url)}
              onToggle={() => onToggleSelected(item.url)}
            />
          ))}
          <Button className="mt-2 min-h-11" disabled={busy || selectedCount === 0} onClick={onImport}>
            {busy ? "Importowanie…" : `Importuj wybrane (${selectedCount}/${selectableCount})`}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Brak wykrytych grup do przejrzenia.</p>
      )}
    </section>
  );
}

const IMPORT_STATUS_LABEL: Record<FacebookGroupImportPreviewItem["status"], string> = {
  NOWA: "Nowa",
  JUZ_W_MANAGERZE: "Już w Managerze",
  MOZLIWY_DUPLIKAT: "Możliwy duplikat",
  WYMAGA_WERYFIKACJI: "Wymaga weryfikacji",
  POMINIETA: "Pominięta",
};

function ImportPreviewRow({ item, name, onNameChange, checked, onToggle }: { item: FacebookGroupImportPreviewItem; name: string; onNameChange: (name: string) => void; checked: boolean; onToggle: () => void }) {
  const selectable = IMPORTABLE_STATUSES.has(item.status);
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label={`Wybierz ${item.discoveredName ?? item.url}`} checked={checked} disabled={!selectable} onChange={onToggle} type="checkbox" />
          <span className="rounded-full bg-gold/10 px-2 py-1 text-[10px] font-bold uppercase text-gold">{IMPORT_STATUS_LABEL[item.status]}</span>
          <span className="truncate text-sm font-semibold">{item.discoveredName ?? "(brak nazwy)"}</span>
        </div>
        <p className="mt-1 break-all text-xs text-muted-foreground">{item.url}</p>
        <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
      </div>
      {selectable ? (
        <input
          aria-label={`Nazwa grupy do importu: ${item.url}`}
          className="h-11 w-full rounded-xl border bg-background px-3 text-sm sm:w-64"
          placeholder="Nazwa grupy przed importem"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}

function HistoricalMappingSection({ mapping, onRefresh }: { mapping: HistoricalFacebookSourceMapping[]; onRefresh: () => void }) {
  if (!mapping.length) return null;
  return (
    <section className="ui-section space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Historyczne źródła Watchera (tylko do odczytu)</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Zatwierdzone źródła kolektora produkcyjnego. Nazwa jest pokazywana tylko wtedy, gdy została już naprawdę przechwycona — dla pozostałych widnieje &quot;{"Nieznana grupa"}&quot;, nigdy zgadywana.
          </p>
        </div>
        <Button variant="outline" className="min-h-11" onClick={onRefresh}><RefreshCw className="size-4" />Odśwież</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr><th className="py-2 pr-4">Nazwa</th><th className="py-2 pr-4">Identyfikator</th><th className="py-2 pr-4">Typ</th><th className="py-2">Adres</th></tr>
          </thead>
          <tbody>
            {mapping.map((entry) => (
              <tr className="border-t" key={entry.sourceId}>
                <td className="py-2 pr-4 font-semibold">{entry.isNamed ? entry.name : <span className="text-muted-foreground">{entry.name}</span>}</td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{entry.sourceId}</td>
                <td className="py-2 pr-4 text-xs uppercase text-muted-foreground">{entry.sourceType}</td>
                <td className="py-2 max-w-xs truncate text-xs text-muted-foreground"><a className="hover:underline" href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{entry.sourceUrl}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GroupSection({ title, empty, groups, onToggle, onEdit, onRemove }: { title: string; empty: string; groups: WatchedFacebookGroup[]; onToggle: (group: WatchedFacebookGroup) => void; onEdit: (group: WatchedFacebookGroup) => void; onRemove: (group: WatchedFacebookGroup) => void }) {
  return <section className="space-y-3"><h2 className="text-lg font-bold">{title}</h2><div className="grid gap-4 lg:grid-cols-2">{groups.map((group) => <GroupCard group={group} key={group.id} onToggle={onToggle} onEdit={onEdit} onRemove={onRemove} />)}{!groups.length ? <div className="ui-section text-sm text-muted-foreground">{empty}</div> : null}</div></section>;
}

function GroupCard({ group, onToggle, onEdit, onRemove }: { group: WatchedFacebookGroup; onToggle: (group: WatchedFacebookGroup) => void; onEdit: (group: WatchedFacebookGroup) => void; onRemove: (group: WatchedFacebookGroup) => void }) {
  return <article className="ui-section"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{resolveFacebookGroupDisplayName(group)}</h3><Status value={group.accessStatus} /><span className="rounded-full border px-2 py-1 text-[10px] font-bold uppercase">{group.priority}</span></div><p className="mt-1 text-sm text-muted-foreground">{[group.neighborhood, group.district, group.city].filter(Boolean).join(" • ")}</p><p className="mt-1 break-all text-xs text-muted-foreground">{groupIdentifier(group.url)}</p></div><button aria-label={group.enabled ? "Wstrzymaj grupę" : "Aktywuj grupę"} className="min-h-11 rounded-xl border px-3 text-xs font-bold" onClick={() => onToggle(group)}>{group.enabled ? "Aktywna" : "Wstrzymana"}</button></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><Metric label="Importy" value={group.importedPosts} /><Metric label="Nowe dziś" value={group.newToday} /><Metric label="Okazje" value={group.opportunities} /><Metric label="Ostatnie sprawdzenie" value={group.lastCheckedAt ? new Date(group.lastCheckedAt).toLocaleString("pl-PL") : "—"} /></div>{group.accessStatus !== "CONNECTED" ? <p className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">Grupa oczekuje na sprawdzenie przez lokalny Facebook worker.</p> : null}{group.lastError ? <p className="mt-2 text-xs text-danger">{group.lastError}</p> : null}<div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={() => onEdit(group)}><Pencil className="size-4" />Edytuj</Button><Button variant="outline" className="min-h-11" onClick={() => onRemove(group)}><Trash2 className="size-4" />Usuń</Button><a className="flex min-h-11 items-center gap-2 px-2 text-sm font-semibold text-gold" href={group.url} target="_blank" rel="noopener noreferrer">Facebook<ExternalLink className="size-4" /></a></div></article>;
}

function EditDialog({ group, busy, onClose, onSave }: { group: WatchedFacebookGroup; busy: boolean; onClose: () => void; onSave: (group: WatchedFacebookGroup, patch: FacebookGroupManagementPatch) => void }) {
  const [draft, setDraft] = useState<FacebookGroupManagementPatch>(() => groupPatch(group));
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Edytuj grupę</DialogTitle><DialogDescription>Zmiany będą użyte automatycznie przy następnym skanie. Adres i identyfikator grupy są niezmienne.</DialogDescription></DialogHeader><div className="grid gap-3"><Field label="Nazwa" value={draft.name} onChange={(name) => setDraft((value) => value ? { ...value, name } : value)} /><Field label="Miasto" value={draft.city} onChange={(city) => setDraft((value) => value ? { ...value, city } : value)} /><label className="grid gap-1 text-sm">Priorytet<SelectPriority value={draft.priority} onChange={(priority) => setDraft((value) => value ? { ...value, priority } : value)} /></label><label className="flex min-h-11 items-center gap-3 rounded-xl border px-3 text-sm"><input checked={draft.enabled} onChange={(event) => setDraft((value) => value ? { ...value, enabled: event.target.checked } : value)} type="checkbox" />Aktywna</label><Field disabled label="Facebook group URL (tylko do odczytu)" value={group.url} onChange={() => undefined} /><Field disabled label="Identyfikator (tylko do odczytu)" value={groupIdentifier(group.url)} onChange={() => undefined} /></div><DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Anuluj</Button><Button disabled={busy || !draft.name.trim() || !draft.city.trim()} onClick={() => onSave(group, draft)}>{busy ? "Zapisywanie…" : "Zapisz"}</Button></DialogFooter></DialogContent></Dialog>;
}

function groupPatch(group: WatchedFacebookGroup, patch: Partial<FacebookGroupManagementPatch> = {}): FacebookGroupManagementPatch { return { name: resolveFacebookGroupDisplayName(group), city: group.city ?? "", priority: group.priority, enabled: group.enabled, ...patch }; }
function groupIdentifier(value: string) { try { return new URL(value).pathname.match(/^\/groups\/([^/]+)/i)?.[1] ?? value; } catch { return value; } }
async function facebookGroupsFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return apiFetch(input, init);
}
function errorMessage(value: unknown, fallback: string) { return value instanceof Error ? value.message : fallback; }
function readDiscoveryTokenFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/^#group-discovery=(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
function clearDiscoveryHash(): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
function Field({ label, value, onChange, placeholder, className = "", disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; className?: string; disabled?: boolean }) { return <label className={`grid gap-1 text-sm ${className}`}>{label}<input className="h-11 rounded-xl border bg-background px-3 disabled:cursor-not-allowed disabled:opacity-70" disabled={disabled} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function SelectPriority({ value, onChange, create = false }: { value: "high" | "normal" | "low"; onChange: (value: "high" | "normal" | "low") => void; create?: boolean }) { return <select className="h-11 rounded-xl border bg-background px-3" value={value} onChange={(event) => onChange(event.target.value as "high" | "normal" | "low")}><option value="normal">Normal</option><option value="high">High</option>{create ? null : <option value="low">Low</option>}</select>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-bold">{value}</p></div>; }
function Status({ value }: { value: WatchedFacebookGroup["accessStatus"] }) { return <span className="rounded-full bg-gold/10 px-2 py-1 text-[10px] font-bold text-gold">{value}</span>; }
