/* eslint-disable @next/next/no-img-element -- Signed private files bypass public image optimization. */
"use client";
import { AttachmentPicker } from "./attachment-picker";
import { ChoiceButtons } from "./assessment-panel";
import { useState } from "react";
import { fileCategories, type FileCategory, type WorkspaceFile } from "./model";
import { Field, Section, inputClass } from "./ui";
type Props = {
  propertyId: string; invested: boolean; files: WorkspaceFile[]; sourceImages: string[];
  upload: (file: File, category: FileCategory) => Promise<string>;
  refresh: () => Promise<WorkspaceFile[]>;
  updateFile: (id: string, name: string, category: FileCategory) => Promise<void>;
};
export function FilesPanel({ propertyId, invested, files, sourceImages, upload, refresh, updateFile }: Props) {
  const [category, setCategory] = useState<FileCategory>(invested ? "before" : "viewing");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [picking, setPicking] = useState(false);
  const [limit, setLimit] = useState(4);
  const allowed = Object.fromEntries(Object.entries(fileCategories).filter(([key]) => invested || ["viewing", "document", "visualization"].includes(key)));
  const filtered = files.filter(file => filter === "all" || file.category === filter);
  return <>
    <Section title="Dodaj zdjęcia lub dokumenty">
      <ChoiceButtons label="Kategoria dokumentu" value={category} options={allowed} onChange={v => setCategory(v as FileCategory)} />
      <AttachmentPicker label="Zdjęcia lub PDF (do 12 MB każdy)" cameraLabel="Zrób zdjęcie" disabled={busy} multiple pdf onPicking={setPicking} onFiles={async batch => {
        if (!batch.length) return;
        if (batch.length > 10) { setNotice("Wybierz maksymalnie 10 plików jednocześnie."); return; }
        setBusy(true); let completed = 0;
        try {
          for (const file of batch) { setNotice(`Przesyłanie ${completed + 1}/${batch.length}: ${file.name}`); await upload(file, category); completed++; }
          setNotice(`Zapisano ${completed} plików. Ponowne dodanie tego samego pliku nie tworzy kopii.`);
        } catch (error) { setNotice(`Zapisano ${completed}/${batch.length}. ${error instanceof Error ? error.message : "Błąd przesyłania."}`); }
        finally { setBusy(false); }
      }} />
      <p role="status" className="text-sm">{notice}</p>
      <p className="text-sm leading-6 text-muted-foreground">Pliki zapisują się od razu. Akty, faktury i własne zdjęcia są prywatne. Linki do podglądu wygasają po 15 minutach — możesz je odświeżyć.</p>
      <button type="button" className="min-h-11 text-sm underline" disabled={busy} onClick={async () => { try { await refresh(); setNotice("Odświeżono linki do plików."); } catch (error) { setNotice(error instanceof Error ? error.message : "Błąd odświeżania."); } }}>Odśwież linki do dokumentów</button>
    </Section>
    <Section title="Twoje zdjęcia i dokumenty">
      <ChoiceButtons label="Pokaż kategorię" value={filter} options={{ all: "Wszystkie", ...Object.fromEntries(Object.entries(fileCategories).filter(([key]) => files.some(f => f.category === key))) }} onChange={v => { setFilter(v); setLimit(4); }} />
      <div className="grid gap-4 sm:grid-cols-2">{filtered.slice(0, limit).map(file => <FileCard key={file.id} propertyId={propertyId} picking={picking} file={file} allowed={allowed} update={async (name, category) => { await updateFile(file.id, name, category); setNotice("Zapisano nazwę i kategorię dokumentu."); }} />)}</div>
      {filtered.length > limit ? <button type="button" className="min-h-11 text-primary underline" onClick={() => setLimit(v => v + 4)}>Pokaż kolejne dokumenty ({filtered.length - limit})</button> : null}
      {!files.length ? <p className="text-sm text-muted-foreground">Brak własnych zdjęć i dokumentów.</p> : null}
    </Section>
    {!picking && sourceImages.length ? <Section title="Zachowane zdjęcia z oferty"><div className="grid grid-cols-2 gap-3">{sourceImages.slice(0, limit).map((url, index) => <img key={`${url}-${index}`} src={url} alt={`Zdjęcie oferty ${index + 1}`} className="aspect-[4/3] w-full rounded-lg object-cover" loading="lazy" decoding="async" referrerPolicy="no-referrer" />)}</div>{sourceImages.length > limit ? <button type="button" className="min-h-11 text-primary underline" onClick={() => setLimit(v => v + 4)}>Pokaż kolejne zdjęcia</button> : null}</Section> : null}
  </>;
}
function FileCard({ propertyId, picking, file, allowed, update }: { propertyId: string; picking: boolean; file: WorkspaceFile; allowed: Record<string, string>; update: (name: string, category: FileCategory) => Promise<void> }) {
  const [name, setName] = useState(file.name), [category, setCategory] = useState(file.category);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <article className="min-w-0 space-y-3 overflow-hidden rounded-xl border p-3">
    <a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`Otwórz dokument: ${file.name}`}>
      {file.mime.startsWith("image/") ? picking ? <div className="aspect-[4/3]" /> : <img src={`/api/properties/${propertyId}/files/${file.id}/preview`} alt={file.name} onError={e => { e.currentTarget.style.display = "none"; }} className="aspect-[4/3] w-full rounded-lg object-cover" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <p className="py-6 text-center font-semibold">PDF — otwórz dokument</p>}
      <p className="mt-2 break-words text-sm font-semibold">{file.name}</p>
    </a>
    <p className="text-xs text-muted-foreground">{fileCategories[file.category]}</p>
    <details><summary className="min-h-11 cursor-pointer text-sm">Zmień nazwę / pomieszczenie i kategorię</summary><div className="space-y-3">
      <Field label="Nazwa dokumentu lub pomieszczenie"><input maxLength={200} className={inputClass} value={name} onChange={e => setName(e.target.value)} /></Field>
      <ChoiceButtons label="Nowa kategoria" value={category} options={{ ...allowed, [file.category]: fileCategories[file.category] }} onChange={v => setCategory(v as FileCategory)} />
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      <button type="button" disabled={busy || !name.trim()} className="min-h-11 rounded-xl border px-4 py-2" onClick={async () => { setBusy(true); setError(""); try { await update(name, category); } catch (error) { setError(error instanceof Error ? error.message : "Nie udało się zapisać."); } finally { setBusy(false); } }}>Zapisz dokument</button>
    </div></details>
  </article>;
}
