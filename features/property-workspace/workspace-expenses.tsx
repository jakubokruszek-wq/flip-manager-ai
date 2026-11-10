"use client";
import { useEffect, useRef, useState } from "react";
import { categories, parseMoney, type Category, type Expense, type FileCategory, type WorkspaceFile } from "./model";
import { recognizeInvoice } from "./invoice-ocr";
import { MAX_FILE_SIZE } from "./files";
import { Field, Section, inputClass } from "./ui";
type Props = { files: WorkspaceFile[]; editing: Expense | null; onCancel: () => void; upload: (file: File, category: FileCategory) => Promise<string>; onAdd: (expense: Expense) => Promise<boolean> };
export function ExpenseForm({ files, editing, onCancel, upload, onAdd }: Props) {
  const [draft, setDraft] = useState(() => ({ description: editing?.description ?? "", supplier: editing?.supplier ?? "", invoiceNumber: editing?.invoiceNumber ?? "", date: editing?.date ?? "", amount: editing ? (editing.amount / 100).toFixed(2) : "", category: editing?.category ?? "renovation" as Category, paid: editing?.paid ?? true, refund: editing?.refund ?? false, fileId: editing?.fileId ?? "" }));
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [ocrText, setOcrText] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return <div id="expense-editor" className="scroll-mt-24"><Section title={editing ? "Edytuj koszt" : "Dodaj koszt / odczytaj fakturę"}>
    <p className="text-sm leading-6 text-muted-foreground">OCR odczytuje zdjęcie w przeglądarce, bez płatnego AI. Przy pierwszym użyciu pobiera język OCR. Sprawdź kwotę brutto i dane dokumentu przed doliczeniem do kosztów.</p>
    <Field label="Zdjęcie faktury — odczytaj OCR"><input type="file" accept="image/jpeg,image/png,image/webp" className={inputClass} disabled={busy} onChange={async e => {
      const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return;
      if (file.size > MAX_FILE_SIZE) { setNotice("Plik jest za duży (maksymalnie 12 MB)."); return; }
      const active = new AbortController(); controller.current = active;
      setBusy(true); setNotice("Zapisywanie zdjęcia faktury…");
      try {
        const fileId = await upload(file, "invoice"); if (active.signal.aborted) return;
        setDraft(previous => ({ ...previous, fileId }));
        const result = await recognizeInvoice(file, setNotice, active.signal);
        if (active.signal.aborted) return;
        setDraft(previous => ({ ...previous, description: previous.description || `Faktura ${result.invoiceNumber || file.name}`.slice(0, 500), supplier: result.supplier || previous.supplier, invoiceNumber: result.invoiceNumber || previous.invoiceNumber, date: result.date || previous.date, amount: result.amount === null ? previous.amount : (result.amount / 100).toFixed(2) }));
        setOcrText(result.text); setNotice("Zdjęcie zapisane, odczyt gotowy. Sprawdź pola — koszt nie został jeszcze doliczony.");
      } catch (error) { if (!active.signal.aborted) setNotice(error instanceof Error ? error.message : "Odczyt nie powiódł się. Wpisz dane ręcznie."); }
      finally { if (!active.signal.aborted) setBusy(false); controller.current = null; }
    }} /></Field>
    {busy ? <button type="button" className="min-h-11 text-sm underline" onClick={() => { controller.current?.abort(); setBusy(false); setNotice("Anulowano OCR. Zapisany dokument pozostaje w załącznikach."); }}>Anuluj odczyt OCR</button> : null}
    <p role="status" className="text-sm">{notice}</p>
    {ocrText ? <details><summary className="min-h-11 cursor-pointer text-sm">Pokaż odczytany tekst</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{ocrText}</pre></details> : null}
    <form className="space-y-4" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setNotice("");
      try {
        const amount = parseMoney(draft.amount); if (amount === null || amount <= 0) throw new Error("Wpisz kwotę większą od zera.");
        const ok = await onAdd({ ...draft, id: editing?.id ?? crypto.randomUUID(), amount, fileId: draft.fileId || null });
        if (ok) { setDraft({ description: "", supplier: "", invoiceNumber: "", date: "", amount: "", category: "renovation", paid: true, refund: false, fileId: "" }); setOcrText(""); setNotice("Koszt zapisany i uwzględniony w rozliczeniu."); }
      } catch (error) { setNotice(error instanceof Error ? error.message : "Nie udało się zapisać kosztu."); }
      finally { setBusy(false); }
    }}>
      <Field label="Opis kosztu"><input required maxLength={500} className={inputClass} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sprzedawca / NIP"><input required={!!draft.invoiceNumber.trim()} maxLength={300} className={inputClass} value={draft.supplier} onChange={e => setDraft({ ...draft, supplier: e.target.value })} /></Field>
        <Field label="Numer faktury lub paragonu"><input maxLength={150} className={inputClass} value={draft.invoiceNumber} onChange={e => setDraft({ ...draft, invoiceNumber: e.target.value })} /></Field>
        <Field label="Data dokumentu"><input type="date" className={inputClass} value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></Field>
        <Field label="Kwota brutto, zł"><input required inputMode="decimal" className={inputClass} value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} /></Field>
        <Field label="Kategoria kosztu"><select className={inputClass} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as Category })}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
        <Field label="Dokument kosztu (opcjonalnie)"><select className={inputClass} value={draft.fileId} onChange={e => setDraft({ ...draft, fileId: e.target.value })}><option value="">Bez dokumentu</option>{files.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></Field>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={draft.paid} onChange={e => setDraft({ ...draft, paid: e.target.checked })} />Zapłacone / otrzymany zwrot</label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={draft.refund} onChange={e => setDraft({ ...draft, refund: e.target.checked })} />To zwrot lub korekta zmniejszająca koszt</label>
      <div className="flex flex-wrap gap-3"><button disabled={busy} className="min-h-12 rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Przetwarzanie…" : editing ? "Zapisz poprawiony koszt" : "Potwierdź dane i dodaj koszt"}</button>{editing ? <button type="button" className="min-h-11 rounded-xl border px-4 py-2" disabled={busy} onClick={onCancel}>Anuluj edycję</button> : null}</div>
    </form>
  </Section></div>;
}
