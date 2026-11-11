"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { PropertyDeleteControl } from "@/features/properties/components/property-delete-control";
import { AssessmentPanel, InspectionPanel, ChoiceButtons } from "./assessment-panel";
import { assess, acquisitionBudgets } from "./assessment";
import { plainText } from "./plain-text";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { categories, isInvestment, money, parseWorkspace, stages, totals, type Category, type Expense, type FileCategory, type Workspace, type WorkspaceFile, type WorkspaceEvent } from "./model";
const FilesPanel = dynamic(() => import("./workspace-files").then(m => m.FilesPanel));
const ExpenseForm = dynamic(() => import("./workspace-expenses").then(m => m.ExpenseForm));
import { Section, Field, Metric, MoneyField, PriceField, TaskForm, inputClass } from "./ui";
import { uploadWorkspaceFile } from "./client";
type PropertyInfo = { id: string; title: string | null; address: string; price: number | null; area: number | null; rooms: number | null; floor: number | null; original_url: string | null; images: string[]; notes: string | null };
export function WorkspaceEditor({ initial }: { initial: { property: PropertyInfo; data: Workspace; version: number; files: WorkspaceFile[]; events: WorkspaceEvent[] } }) {
  const router = useRouter();
  const editorRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState(initial.data);
  const [version, setVersion] = useState(initial.version);
  const [files, setFiles] = useState(initial.files);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");
  const [acquiring, setAcquiring] = useState(false);
  const invested = isInvestment(data.stage);
  const t = totals(data);
  const asking = initial.property.price === null ? null : Math.round(initial.property.price * 100);
  const decision = assess(data.assessment, data.expectedSalePrice, data.offerPrice ?? asking);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const change = (patch: Partial<Workspace>) => { setData(previous => ({ ...previous, ...patch })); setDirty(true); setMessage(""); };
  async function save(next = data) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (editorRef.current?.querySelector('[aria-invalid="true"]')) throw new Error("Popraw nieprawidłową kwotę przed zapisaniem.");
      const parsed = parseWorkspace(next);
      const response = await fetch(`/api/properties/${initial.property.id}/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, data: parsed }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Nie udało się zapisać.");
      setData(parsed); setAcquiring(false); setVersion(body.version); setDirty(false); setMessage("Zapisano zmiany."); router.refresh();
      if (isInvestment(parsed.stage) !== isInvestment(initial.data.stage)) { setTab("overview"); router.replace(`${isInvestment(parsed.stage) ? "/investments" : "/properties"}/${initial.property.id}`); }
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się zapisać."); return false; }
    finally { setBusy(false); }
  }
  async function refreshFiles() {
    const response = await fetch(`/api/properties/${initial.property.id}/workspace`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? "Nie udało się odświeżyć dokumentów.");
    setFiles(body.files as WorkspaceFile[]);
    return body.files as WorkspaceFile[];
  }
  async function upload(file: File, category: FileCategory) {
    const id = await uploadWorkspaceFile(initial.property.id, file, category);
    await refreshFiles(); return id;
  }
  async function updateFile(id: string, name: string, category: FileCategory) {
    const response = await fetch(`/api/properties/${initial.property.id}/files`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name, category }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.message || "Nie udało się zapisać dokumentu.");
    await refreshFiles();
  }
  const tabs = invested ? [{ id: "overview", label: "Podsumowanie" }, { id: "files", label: "Zdjęcia i dokumenty" }, { id: "costs", label: "Budżet i faktury" }, { id: "tasks", label: "Plan i wykonawcy" }, { id: "sale", label: "Sprzedaż" }] : [{ id: "overview", label: "Podsumowanie" }, { id: "viewing", label: "Oglądanie" }, { id: "estimate", label: "Kosztorys i opłacalność" }, { id: "files", label: "Zdjęcia i dokumenty" }];
  return <div ref={editorRef} className="min-w-0 space-y-6 pb-28">
    <Link className="text-sm text-primary underline" href={invested ? "/investments" : "/properties"}>← {invested ? "Inwestycje" : "Nieruchomości"}</Link>
    <header className="space-y-3"><div className="flex justify-end"><PropertyDeleteControl propertyId={initial.property.id} onDeleted={() => { setDirty(false); router.push(invested ? "/investments" : "/properties"); router.refresh(); }} /></div><p className="text-sm font-semibold text-primary">{stages[data.stage]}</p><h1 className="break-words text-2xl font-bold">{initial.property.title || initial.property.address}</h1><p className="text-muted-foreground">{initial.property.address}</p></header>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="tablist" aria-label="Sekcje nieruchomości" onKeyDown={event => { const index = tabs.findIndex(item => item.id === tab); const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1; if (next >= 0) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); } }}>{tabs.map(item => <button key={item.id} type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} onClick={() => setTab(item.id)} className={`min-h-12 min-w-0 rounded-2xl border px-3 py-3 text-sm font-semibold ${tab === item.id ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{item.label}</button>)}</div>
    <div aria-live="polite">{message ? <p className="rounded-xl border border-emerald-600 p-3 text-sm">{message}</p> : null}{error ? <p role="alert" className="rounded-xl border border-red-500 p-3 text-sm">{error}</p> : null}</div>
    <fieldset disabled={busy} className="min-w-0 space-y-5 disabled:opacity-70"><div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-w-0 space-y-5">
    {tab === "overview" ? <>
      <section className="grid grid-cols-2 gap-3"><Metric label="Cena ofertowa" value={money(asking)} /><Metric label="Powierzchnia" value={initial.property.area === null ? "—" : `${initial.property.area.toLocaleString("pl")} m²`} /><Metric label="Pokoje / piętro" value={`${initial.property.rooms ?? "—"} / ${initial.property.floor ?? "—"}`} />{invested ? <><Metric label="Cena zakupu" value={money(data.purchasePrice)} /><Metric label="Zakup + wszystkie koszty" value={money(t.cost)} /><Metric label={data.stage === "sold" ? "Wynik sprzedaży" : "Prognoza zysku"} value={money(t.profit)} /></> : <><Metric label="Szacowana sprzedaż" value={money(data.expectedSalePrice)} /><Metric label="Maksymalna cena zakupu" value={money(decision.maxPurchase)} /><Metric label="Minimalny zysk" value={money(data.assessment.minimumProfit)} /></>}</section>
      <p className="text-sm leading-6 text-muted-foreground">{invested ? "Prognoza uwzględnia pozostały budżet oraz zarejestrowane koszty. Uzupełnij wszystkie kategorie budżetu, wpisując 0 dla kosztów, które nie wystąpią." : "Oceń stan mieszkania w Oglądaniu, a następnie uzupełnij Kosztorys i opłacalność. Limit zakupu pojawi się po uzupełnieniu wszystkich założeń."}</p>
      <Section title={invested ? "Etap inwestycji" : "Etap zainteresowania"}><ChoiceButtons label="Etap" value={data.stage} options={Object.fromEntries(Object.entries(stages).filter(([key]) => isInvestment(key as Workspace["stage"]) === invested))} onChange={stage => change({ stage: stage as Workspace["stage"] })} />
      {invested ? <div className="grid gap-4 sm:grid-cols-2"><PriceField label="Faktyczna cena zakupu" value={data.purchasePrice} onChange={purchasePrice => change({ purchasePrice })} /><Field label="Data zakupu"><input type="date" className={inputClass} value={data.purchaseDate} onChange={e => change({ purchaseDate: e.target.value })} /></Field><Field label="Planowany koniec inwestycji"><input type="date" className={inputClass} value={data.targetDate} onChange={e => change({ targetDate: e.target.value })} /></Field></div> : <><button type="button" className="min-h-12 rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground" onClick={() => setAcquiring(v => !v)}>Kupiona — utwórz inwestycję</button>{acquiring ? <div className="space-y-4 rounded-2xl border border-primary/40 p-4"><p className="text-sm leading-6 text-muted-foreground">Potwierdź faktyczny zakup. Ta sama karta przejdzie do Inwestycji wraz z dokumentami, oglądaniem i kosztorysem.</p><PriceField label="Faktyczna cena zakupu" value={data.purchasePrice} onChange={purchasePrice => change({ purchasePrice })} /><Field label="Data zakupu"><input type="date" className={inputClass} value={data.purchaseDate} onChange={e => change({ purchaseDate: e.target.value })} /></Field><button type="button" className="min-h-12 rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground" onClick={() => save({ ...data, stage: "acquired", budgets: acquisitionBudgets(data.assessment, data.expectedSalePrice, data.purchasePrice, data.budgets) as Workspace["budgets"] })}>Potwierdź zakup i przenieś do Inwestycji</button></div> : null}</>}
      </Section>
      {invested && (data.notes || data.viewingAt || Object.values(data.assessment.repairs).some(r => r.condition !== "unknown")) ? <Section title="Historia przed zakupem"><p className="whitespace-pre-wrap break-words text-sm">{data.notes}</p><p className="text-sm text-muted-foreground">{data.viewingAt.replace("T", " ")}</p><details><summary className="min-h-11 cursor-pointer text-primary">Zachowany kosztorys przed zakupem</summary><p className="text-sm">Planowana sprzedaż: {money(data.expectedSalePrice)} · limit zakupu: {money(decision.maxPurchase)} · minimalny zysk: {money(data.assessment.minimumProfit)}</p></details></Section> : null}
      {initial.events.length ? <Section title="Historia zapisów"><ol className="space-y-3">{initial.events.map(event => <li key={event.version} className="border-l-2 border-primary/40 pl-3 text-sm"><p className="font-semibold">{stages[event.stage]} · zapis {event.version}</p><p className="text-muted-foreground">{new Date(event.created_at).toLocaleString("pl-PL")} · koszty: {event.expense_count}, zadania: {event.task_count}</p></li>)}</ol><p className="text-xs text-muted-foreground">Ostatnie 50 zapisów karty.</p></Section> : null}
      {initial.property.notes ? <details className="rounded-2xl border p-4"><summary className="min-h-11 cursor-pointer text-sm text-primary">Opis z ogłoszenia</summary><p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{plainText(initial.property.notes)}</p></details> : null}
      <Link className="inline-block min-h-11 text-primary underline" href={`/properties/${initial.property.id}/details`}>Dane źródłowe i edycja oferty</Link>
    </> : null}
    {tab === "viewing" ? <Section title="Oglądanie mieszkania"><Field label="Kontakt do właściciela / pośrednika"><textarea className={inputClass} maxLength={1000} value={data.contact} onChange={e => change({ contact: e.target.value })} /></Field><Field label="Termin oglądania (czas lokalny)"><input type="datetime-local" className={inputClass} value={data.viewingAt} onChange={e => change({ viewingAt: e.target.value })} /></Field><InspectionPanel value={data.assessment} onChange={assessment => change({ assessment })} /><Field label="Notatki z oglądania, ustalenia i negocjacje"><textarea rows={10} className={inputClass} maxLength={30000} value={data.notes} onChange={e => change({ notes: e.target.value })} /></Field><p className="text-sm text-muted-foreground">Zdjęcia z oglądania dodasz w „Zdjęcia i dokumenty”. Notatki możesz dyktować przyciskiem mikrofonu w klawiaturze telefonu.</p></Section> : null}
    {tab === "estimate" && !invested ? <AssessmentPanel data={data} area={initial.property.area} asking={asking} change={change} /> : null}
    {tab === "files" ? <FilesPanel propertyId={initial.property.id} invested={invested} files={files} sourceImages={initial.property.images} upload={upload} refresh={refreshFiles} updateFile={updateFile} /> : null}
    {tab === "costs" && invested ? <><Section title="Budżet kosztów dodatkowych"><p className="text-sm leading-6 text-muted-foreground">Cena zakupu jest liczona oddzielnie. Wpisz 0, jeśli dana kategoria nie wystąpi; puste pole oznacza brak planu.</p><div className="grid gap-4 sm:grid-cols-2">{Object.entries(categories).map(([key, label]) => <MoneyField key={key} label={label} value={data.budgets[key as Category]} onChange={amount => change({ budgets: { ...data.budgets, [key]: amount } })} />)}</div><div className="grid grid-cols-2 gap-3"><Metric label={t.budgetComplete ? "Plan dodatkowych kosztów" : "Częściowy plan kosztów"} value={money(t.budget)} /><Metric label="Zarejestrowane koszty netto zwrotów" value={money(t.committed)} /><Metric label="Zapłacone netto zwrotów" value={money(t.paid)} /><Metric label="Do zapłaty netto zwrotów" value={money(t.unpaid)} /><Metric label={t.budgetComplete ? "Pozostało z budżetu" : "Różnica względem częściowego planu"} value={money(t.remaining)} /></div></Section>
      <ExpenseForm propertyId={initial.property.id} key={editing?.id ?? "new-expense"} editing={editing} onCancel={() => setEditing(null)} files={files} upload={upload} onAdd={async expense => { const next = { ...data, expenses: editing ? data.expenses.map(item => item.id === expense.id ? expense : item) : [...data.expenses, expense] }; if (await save(next)) { setEditing(null); return true; } return false; }} />
      <Section title={`Koszty (${data.expenses.length})`}>{data.expenses.length ? data.expenses.map(expense => <article key={expense.id} className="space-y-2 rounded-xl border border-border p-4"><p className="break-words font-semibold">{expense.description}</p><p className="text-sm text-muted-foreground">{expense.date || "Bez daty"} · {categories[expense.category]} · {expense.supplier} {expense.invoiceNumber}</p><p className="font-semibold">{expense.refund ? "Zwrot: " : ""}{money(expense.amount)}</p><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={expense.paid} onChange={e => change({ expenses: data.expenses.map(item => item.id === expense.id ? { ...item, paid: e.target.checked } : item) })} />{expense.refund ? "Zwrot otrzymany" : "Zapłacono"}</label>{expense.fileId ? <p className="text-xs text-muted-foreground">Dokument dostępny w „Zdjęcia i dokumenty”.</p> : null}<button type="button" className="mr-4 min-h-11 text-sm text-primary underline" onClick={() => { setEditing(expense); document.getElementById("expense-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Edytuj koszt</button><button type="button" className="min-h-11 text-sm text-red-400 underline" onClick={() => change({ expenses: data.expenses.filter(item => item.id !== expense.id) })}>Usuń koszt z rozliczenia</button></article>) : <p className="text-sm text-muted-foreground">Dodaj pierwszy wydatek lub fakturę. Same dokumenty nie zwiększają kosztów.</p>}</Section>
    </> : null}
    {tab === "tasks" && invested ? <Section title="Plan remontu i wykonawcy"><TaskForm onAdd={async (title, contractor, dueDate) => save({ ...data, tasks: [...data.tasks, { id: crypto.randomUUID(), title, contractor, dueDate, done: false }] })} />{data.tasks.map(task => <div key={task.id} className="space-y-2 rounded-xl border p-4"><label className="flex items-start gap-3"><input type="checkbox" checked={task.done} onChange={e => change({ tasks: data.tasks.map(item => item.id === task.id ? { ...item, done: e.target.checked } : item) })} /><span className={task.done ? "line-through" : ""}>{task.title}</span></label><p className="text-sm text-muted-foreground">{task.contractor || "Bez wykonawcy"} · {task.dueDate || "Bez terminu"}</p><button type="button" className="min-h-11 text-sm underline" onClick={() => change({ tasks: data.tasks.filter(item => item.id !== task.id) })}>Usuń zadanie</button></div>)}</Section> : null}
    {tab === "sale" && invested ? <Section title="Sprzedaż i rozliczenie"><PriceField label="Planowana cena sprzedaży" value={data.expectedSalePrice} onChange={expectedSalePrice => change({ expectedSalePrice })} /><PriceField label="Faktyczna cena sprzedaży" value={data.salePrice} onChange={salePrice => change({ salePrice })} /><Field label="Data sprzedaży"><input type="date" className={inputClass} value={data.saleDate} onChange={e => change({ saleDate: e.target.value })} /></Field><div className="grid grid-cols-2 gap-3"><Metric label="Zakup + zarejestrowane koszty" value={money(t.cost)} /><Metric label="Prognozowany koszt końcowy" value={money(t.estimatedCost)} /><Metric label={data.stage === "sold" ? "Wynik sprzedaży" : "Prognoza zysku"} value={money(t.profit)} /><Metric label={data.stage === "sold" ? "ROI na wpisanych kosztach" : "Prognozowany ROI"} value={t.roi === null ? "—" : `${t.roi.toFixed(1)}%`} /><Metric label="Pozostałe zobowiązania netto" value={money(t.unpaid)} /></div>{invested ? <button type="button" className="min-h-12 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground" onClick={() => save({ ...data, stage: "sold" })}>Oznacz jako sprzedaną i zapisz</button> : null}<p className="text-sm text-muted-foreground">Prognoza obejmuje pozostały budżet. Wynik po sprzedaży obejmuje zarejestrowane koszty, również niezapłacone. Uzupełnij podatek i koszty sprzedaży przed końcowym rozliczeniem.</p></Section> : null}
    </div></fieldset>
    <div className="sticky bottom-24 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-card p-4 shadow-lg lg:bottom-4"><p className="text-sm" role="status">{dirty ? "Masz niezapisane zmiany" : "Zmiany zapisane"}</p><button type="button" disabled={busy} onClick={() => save()} className="min-h-12 rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground disabled:opacity-60">{busy ? "Zapisywanie…" : "Zapisz zmiany"}</button></div>
  </div>;
}
