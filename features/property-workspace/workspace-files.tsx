/* eslint-disable @next/next/no-img-element -- Signed private files bypass public image optimization. */
"use client";
import { useState } from "react";
import { fileCategories, type FileCategory, type WorkspaceFile } from "./model";
import { Field, Section, inputClass } from "./ui";
type Props = {
  files: WorkspaceFile[]; sourceImages: string[];
  upload: (file: File, category: FileCategory) => Promise<string>;
  refresh: () => Promise<WorkspaceFile[]>;
  updateFile: (id: string, name: string, category: FileCategory) => Promise<void>;
};
export function FilesPanel({ files, sourceImages, upload, refresh, updateFile }: Props) {
  const [category, setCategory] = useState<FileCategory>("viewing");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  return <>
    <Section title="Dodaj zdjęcia lub dokumenty">
      <Field label="Kategoria dokumentu"><select className={inputClass} value={category} onChange={e => setCategory(e.target.value as FileCategory)}>{Object.entries(fileCategories).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
      <Field label="Zdjęcia lub PDF (do 12 MB każdy)"><input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy} className={inputClass} onChange={async e => {
        const batch = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = "";
        if (!batch.length) return;
        if (batch.length > 10) { setNotice("Wybierz maksymalnie 10 plików jednocześnie."); return; }
        setBusy(true); let completed = 0;
        try {
          for (const file of batch) { setNotice(`Przesyłanie ${completed + 1}/${batch.length}: ${file.name}`); await upload(file, category); completed++; }
          setNotice(`Zapisano ${completed} plików. Ponowne dodanie tego samego pliku nie tworzy kopii.`);
        } catch (error) { setNotice(`Zapisano ${completed}/${batch.length}. ${error instanceof Error ? error.message : "Błąd przesyłania."}`); }
        finally { setBusy(false); }
      }} /></Field>
      <p role="status" className="text-sm">{notice}</p>
      <p className="text-sm leading-6 text-muted-foreground">Pliki zapisują się od razu. Akty, faktury i własne zdjęcia są prywatne. Linki do podglądu wygasają po 15 minutach — możesz je odświeżyć.</p>
      <button type="button" className="min-h-11 text-sm underline" disabled={busy} onClick={async () => { try { await refresh(); setNotice("Odświeżono linki do plików."); } catch (error) { setNotice(error instanceof Error ? error.message : "Błąd odświeżania."); } }}>Odśwież linki do dokumentów</button>
    </Section>
    <Section title="Twoje zdjęcia i dokumenty">
      <Field label="Pokaż kategorię"><select value={filter} className={inputClass} onChange={e => setFilter(e.target.value)}><option value="all">Wszystkie</option>{Object.entries(fileCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <div className="grid gap-4 sm:grid-cols-2">{files.filter(file => filter === "all" || file.category === filter).map(file => <FileCard key={file.id} file={file} update={async (name, category) => { await updateFile(file.id, name, category); setNotice("Zapisano nazwę i kategorię dokumentu."); }} />)}</div>
      {!files.length ? <p className="text-sm text-muted-foreground">Brak własnych zdjęć i dokumentów.</p> : null}
    </Section>
    {sourceImages.length ? <Section title="Zachowane zdjęcia z oferty"><div className="grid grid-cols-2 gap-3">{sourceImages.map((url, index) => <img key={`${url}-${index}`} src={url} alt={`Zdjęcie oferty ${index + 1}`} className="aspect-[4/3] w-full rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" />)}</div></Section> : null}
  </>;
}
function FileCard({ file, update }: { file: WorkspaceFile; update: (name: string, category: FileCategory) => Promise<void> }) {
  const [name, setName] = useState(file.name), [category, setCategory] = useState(file.category);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <article className="min-w-0 space-y-3 overflow-hidden rounded-xl border p-3">
    <a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`Otwórz dokument: ${file.name}`}>
      {file.mime.startsWith("image/") ? <img src={file.url} alt={file.name} className="aspect-[4/3] w-full rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" /> : <p className="py-6 text-center font-semibold">PDF — otwórz dokument</p>}
      <p className="mt-2 break-words text-sm font-semibold">{file.name}</p>
    </a>
    <p className="text-xs text-muted-foreground">{fileCategories[file.category]}</p>
    <details><summary className="min-h-11 cursor-pointer text-sm">Zmień nazwę / pomieszczenie i kategorię</summary><div className="space-y-3">
      <Field label="Nazwa dokumentu lub pomieszczenie"><input maxLength={200} className={inputClass} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Nowa kategoria"><select className={inputClass} value={category} onChange={e => setCategory(e.target.value as FileCategory)}>{Object.entries(fileCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      <button type="button" disabled={busy || !name.trim()} className="min-h-11 rounded-xl border px-4 py-2" onClick={async () => { setBusy(true); setError(""); try { await update(name, category); } catch (error) { setError(error instanceof Error ? error.message : "Nie udało się zapisać."); } finally { setBusy(false); } }}>Zapisz dokument</button>
    </div></details>
  </article>;
}
