"use client";
import { useEffect, useRef, useState } from "react";
import { answerUnit, roomQuestions, type AnswerCommand, type AnswerInput, type DealRoomState } from "../deal-room-answers";
import type { CanonicalDeal } from "../types";
import { formatPLNDisplay } from "./investment-ui";

export function DirectorQuestions({ deal, onAnalyzed }: { deal: CanonicalDeal; onAnalyzed: (deal: CanonicalDeal) => void }) {
  const [room, setRoom] = useState<DealRoomState | null>(null), [draft, setDraft] = useState<Record<string, AnswerInput>>({});
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [more, setMore] = useState(false), [disabled, setDisabled] = useState(false);
  const pending = useRef<AnswerCommand | null>(null);
  const path = `/api/flip-finder/listings/${encodeURIComponent(deal.listingId)}/investment/answers`;
  useEffect(() => {
    let active = true;
    void fetch(path, { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (response.ok && body.enabled === false) { setDisabled(true); return; }
      if (!response.ok || !body.room) throw Error("Nie udało się wczytać zapisanych odpowiedzi.");
      setRoom(body.room);
    }).catch(() => { if (active) setError("Nie udało się wczytać odpowiedzi. Odśwież stronę."); });
    return () => { active = false; };
  }, [path, deal.updatedAt]);
  const change = (field: string, patch: Partial<AnswerInput>) => {
    pending.current = null;
    setDraft((current) => {
      const base: AnswerInput = current[field] ?? room?.answers[field] ?? { field, kind: "VALUE", value: null, basis: "DECLARATION", evidenceUrl: null };
      return { ...current, [field]: { ...base, ...patch } };
    });
  };
  const save = async () => {
    if (!room || saving) return;
    setSaving(true); setError(null);
    const command = pending.current ?? { requestId: crypto.randomUUID(), expectedVersion: room.version, answers: Object.values(draft) };
    pending.current = command;
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const body = await response.json();
      if (!response.ok || !body.deal || !body.room) { if (response.status < 500) pending.current = null; throw Error(body.message ?? "Nie udało się zapisać odpowiedzi. Odśwież analizę przy konflikcie wersji."); }
      setRoom(body.room); setDraft({}); pending.current = null; onAnalyzed(body.deal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Błąd połączenia. Ponów ten sam zapis."); }
    finally { setSaving(false); }
  };
  const questions = roomQuestions(deal, room ?? { version: 0, answers: {}, baselineOverrides: {}, rounds: [] });
  const latest = room?.rounds.at(-1);
  const keys = new Set(questions.map((q) => q.field));
  const editing = Object.keys(draft).filter((field) => !keys.has(field));
  const visible = (more ? questions : questions.slice(0, 5)).concat(editing.map((field) => ({ field, question: `Edytuj odpowiedź: ${field}`, directors: "CEO", why: "Nowa runda zachowa poprzednią odpowiedź w historii.", evidence: "Deklaracja nie jest automatycznie zweryfikowanym dowodem.", blocking: false })));
  return <section data-user-questions aria-label="Dyrektorzy pytają Ciebie" className="min-w-0 space-y-4 rounded-2xl border border-amber-400/20 p-4">
    <h2 className="text-lg font-semibold">Dyrektorzy pytają Ciebie</h2>
    <p className="text-xs text-muted-foreground">Analizy regułowe Investment OS. PCC, notariusz, finansowanie i sprzedaż są scenariuszem z ustawień, a nie potwierdzonymi kosztami tej transakcji. Odpowiedź i link do dokumentu nie są automatycznym potwierdzeniem faktu prawnego ani ceny transakcyjnej. Nie wpisuj haseł, tokenów ani danych osób z dokumentów.</p>
    {disabled ? <p>Trwałe odpowiedzi nie są aktywne w tym środowisku.</p> : null}
    {visible.map((q) => { const answer = draft[q.field] ?? room?.answers[q.field], unit = answerUnit(q.field), numeric = unit !== "opis / ustalenie"; return <fieldset key={q.field} disabled={saving || !room} className="min-w-0 space-y-2 rounded-xl border border-white/10 p-3" data-question-field={q.field}>
      <legend className="break-words text-sm font-semibold">{q.question}</legend>
      <p className="text-xs">{q.directors} · {q.blocking ? "Pytanie blokujące" : "Założenie / dane do analizy"}</p>
      <p className="text-xs text-muted-foreground">{q.why} Potwierdzenie: {q.evidence}</p>
      <label className="block text-xs">Rodzaj odpowiedzi<select aria-label={`Rodzaj: ${q.field}`} className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={answer?.kind ?? "VALUE"} onChange={(e) => change(q.field, { kind: e.target.value as AnswerInput["kind"] })}><option value="VALUE">Podaję wartość</option><option value="UNKNOWN">Nie wiem</option><option value="LATER">Sprawdzę później</option><option value="WITHDRAW">Cofam odpowiedź</option></select></label>
      {(answer?.kind ?? "VALUE") === "VALUE" ? <>
        <label className="block text-xs">Odpowiedź ({unit})<input aria-label={`Odpowiedź: ${q.field}`} className="mt-1 min-h-11 w-full min-w-0 rounded border bg-background p-2" type={numeric ? "number" : "text"} inputMode={numeric ? "decimal" : "text"} maxLength={2000} value={answer?.value ?? ""} onChange={(e) => change(q.field, { value: numeric && e.target.value !== "" ? Number(e.target.value) : e.target.value })} /></label>
        <label className="block text-xs">Podstawa<select aria-label={`Podstawa: ${q.field}`} className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={answer?.basis ?? "DECLARATION"} onChange={(e) => change(q.field, { basis: e.target.value as AnswerInput["basis"] })}><option value="DECLARATION">Moja deklaracja</option><option value="ASSUMPTION">Założenie do kalkulacji</option><option value="DOCUMENT_REFERENCE">Link do dokumentu — do weryfikacji</option></select></label>
        <label className="block text-xs">Link do dowodu (opcjonalny HTTPS, bez tokenów)<input aria-label={`Dokument: ${q.field}`} className="mt-1 min-h-11 w-full min-w-0 rounded border bg-background p-2" type="url" value={answer?.evidenceUrl ?? ""} onChange={(e) => change(q.field, { evidenceUrl: e.target.value || null })} /></label>
      </> : null}
      {room?.answers[q.field] ? <p className="break-words text-xs">Stan: {room.answers[q.field].status === "RESOLVED" ? "Założenie przyjęte do obliczeń" : "Wymaga dowodu / dalszego ustalenia"} · {room.answers[q.field].savedAt}</p> : null}
    </fieldset>; })}
    {!more && questions.length > 5 ? <button type="button" className="min-h-11 underline" onClick={() => setMore(true)}>Pozostałe pytania ({questions.length - 5})</button> : null}
    {room ? <button type="button" className="min-h-11 rounded-xl bg-gold px-4 font-semibold text-black disabled:opacity-50" disabled={saving || Object.keys(draft).length === 0} onClick={() => void save()}>{saving ? "Zapisuję i przeliczam…" : "Zapisz odpowiedzi i przelicz"}</button> : null}
    {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
    {room && Object.keys(room.answers).length > 0 ? <details><summary className="min-h-11 cursor-pointer">Zapisane odpowiedzi — edycja i cofnięcie</summary>{Object.values(room.answers).map((a) => <article key={a.field} className="my-2 break-words rounded border p-2 text-xs"><strong>{a.field}</strong>: {a.value ?? (a.kind === "LATER" ? "Sprawdzę później" : a.kind === "WITHDRAW" ? "Cofnięto" : "Nie wiem")} · {a.basis} · {a.savedAt}<button type="button" className="ml-2 min-h-11 underline" onClick={() => change(a.field, {})}>Edytuj</button><button type="button" className="ml-2 min-h-11 underline" onClick={() => change(a.field, { kind: "WITHDRAW", value: null })}>Cofnij</button></article>)}</details> : null}
    {latest ? <section aria-label="Rekomendacja przed i po odpowiedziach" className="space-y-2 border-t pt-3 text-sm"><h3 className="font-semibold">Co zmieniły odpowiedzi?</h3><p>Pola: {latest.changedFields.join(", ")}. Zależne dyrekcje: {latest.invalidated.join(", ") || "brak zmian finansowych"}.</p><p>CEO: {latest.before.ceo.decision} → {latest.after.ceo.decision} · rekomendacja warunkowa, do weryfikacji.</p><p>Zysk bazowy: {formatPLNDisplay(latest.before.financials?.profitBase ?? null)} → {formatPLNDisplay(latest.after.financials?.profitBase ?? null)}</p><p>Max Buy: {formatPLNDisplay(latest.before.financials?.maxPurchasePrice ?? null)} → {formatPLNDisplay(latest.after.financials?.maxPurchasePrice ?? null)}</p><p>{latest.after.ceo.reasoningSummary}</p><p>Runda zamknięta: {latest.after.questions.some((q) => q.category === "BLOCKING") ? "nie — pozostały pytania blokujące" : "brak otwartych pytań blokujących w projekcji; wymagane zatwierdzenie człowieka"}.</p><ol className="list-decimal pl-5">{[latest.after.ceo.nextBestAction.title, ...latest.after.ceo.conditionsToProceed].slice(0, 3).map((step, i) => <li key={i}>{step}</li>)}</ol></section> : null}
  </section>;
}
