"use client";
import { investmentPath } from "../test-identity";
import { useEffect, useRef, useState } from "react";
import { answerSourceFingerprint, answerUnit, roomQuestions, type AnswerCommand, type AnswerInput, type DealRoomState } from "../deal-room-answers";
import type { CanonicalDeal } from "../types";
import { formatPLNDisplay } from "./investment-ui";

export function DirectorQuestions({ deal, onAnalyzed, scope = "other" }: { deal: CanonicalDeal; onAnalyzed: (deal: CanonicalDeal) => void; scope?: "other" | "target" }) {
  const [room, setRoom] = useState<DealRoomState | null>(null), [draft, setDraft] = useState<Record<string, AnswerInput>>({});
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [saving, setSaving] = useState(false), [more, setMore] = useState(false), [disabled, setDisabled] = useState(false);
  const pending = useRef<AnswerCommand | null>(null);
  const path = `${investmentPath(deal.listingId)}/answers`;
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
  }, [path, deal]);
  useEffect(() => {
    const focusQuestion=(event?:Event)=>{
      const match=window.location.hash.match(/^#deal-question-([A-Za-z0-9_]+)$/);if(!match)return;
      const field=match[1],available=roomQuestions(deal,room??{version:0,answers:{},baselineOverrides:{},rounds:[]});
      if(!available.some(q=>q.field===field)){
        if(event?.type!=="hashchange"||!room?.answers[field])return;
        pending.current=null;setDraft(old=>({...old,[field]:room.answers[field]}));
      }
      setMore(true);
      window.setTimeout(()=>{const target=document.getElementById(`deal-question-${field}`);target?.focus();target?.scrollIntoView({block:"start",behavior:"smooth"});},0);
    };
    window.addEventListener("hashchange",focusQuestion);const timer=window.setTimeout(()=>focusQuestion(),0);
    return ()=>{window.clearTimeout(timer);window.removeEventListener("hashchange",focusQuestion);};
  },[deal,room]);
  const change = (field: string, patch: Partial<AnswerInput>) => {
    pending.current = null;
    setDraft((current) => {
      const base: AnswerInput = current[field] ?? room?.answers[field] ?? { field, kind: "VALUE", value: null, basis: "DECLARATION", evidenceUrl: null };
      return { ...current, [field]: { ...base, ...patch } };
    });
  };
  const save = async () => {
    if (!room || saving) return;
    setSaving(true); setError(null); setNotice(null);
    const command = pending.current ?? { requestId: crypto.randomUUID(), expectedVersion: room.version, answers: Object.values(draft) };
    pending.current = command;
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const body = await response.json();
      if (response.status === 409) {
        // Optimistic concurrency: refresh authoritative state, NEVER overwrite
        // another user's saved answer. Keep the current draft for explicit retry.
        const [dealResponse, roomResponse] = await Promise.all([
          fetch(path.replace(/\/answers$/, ""), { cache: "no-store" }),
          fetch(path, { cache: "no-store" }),
        ]);
        const latestDeal = await dealResponse.json(), latestRoom = await roomResponse.json();
        if (dealResponse.ok && roomResponse.ok && latestDeal.deal && latestRoom.room) {
          setRoom(latestRoom.room);
          onAnalyzed(latestDeal.deal);
        }
        pending.current = null;
        throw Error("Analiza została zaktualizowana. Pobieram najnowsze dane — Twoja kwota została zachowana. Sprawdź ją i kliknij Zapisz ponownie.");
      }
      if (!response.ok || !body.deal || !body.room) { if (response.status < 500) pending.current = null; throw Error(body.message ?? "Nie udało się zapisać odpowiedzi."); }
      // A replay can return an older immutable receipt. Render the current read
      // model, not that historical response; retain request/draft if reads fail.
      const [dealResponse, roomResponse] = await Promise.all([
        fetch(path.replace(/\/answers$/, ""), { cache: "no-store" }),
        fetch(path, { cache: "no-store" }),
      ]);
      const currentDeal = await dealResponse.json(), currentRoom = await roomResponse.json();
      if (!dealResponse.ok || !roomResponse.ok || !currentDeal.deal || !currentRoom.room) throw Error("Odpowiedzi zapisane, ale nie udało się wczytać aktualnej analizy. Ponów zapis, aby odzyskać wynik.");
      setRoom(currentRoom.room); setDraft({}); pending.current = null; onAnalyzed(currentDeal.deal); setNotice("Zapisano — analiza CEO i cena powodzenia zostały automatycznie przeliczone.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Błąd połączenia. Ponów ten sam zapis."); }
    finally { setSaving(false); }
  };
  const questions = roomQuestions(deal, room ?? { version: 0, answers: {}, baselineOverrides: {}, rounds: [] }).filter(q => scope === "target" ? q.field === "targetProfitPLN" : q.field !== "targetProfitPLN");
  const latest = room?.rounds.at(-1);
  if (scope === "target") {
    const answer = draft.targetProfitPLN ?? room?.answers.targetProfitPLN;
    const original = room?.answers.targetProfitPLN;
    const defaultTarget = deal.underwriting.result?.successPrice?.targetProfitPLN ?? null;
    const value = answer?.kind === "VALUE" ? answer.value : answer ? "" : defaultTarget;
    const stale = Boolean(original && original.sourceFingerprint !== answerSourceFingerprint(deal, "targetProfitPLN"));
    return <div className="mt-3 space-y-2 rounded-xl border border-gold/35 bg-black/20 p-3" data-success-target-editor>
      <label htmlFor="deal-success-target-input" className="block text-sm font-bold text-gold">Jaki zysk chcesz zarobić na tej transakcji?</label>
      <p className="text-xs text-muted-foreground">Wpisz docelowy zysk w złotych (przed podatkiem). Po zapisaniu ceny i analiza przeliczą się tutaj automatycznie.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1"><input id="deal-success-target-input" aria-label="Docelowy zysk operacyjny PLN" type="number" inputMode="decimal" min="0" max="100000000" step="0.01" className="min-h-11 w-full rounded-lg border border-gold/40 bg-background px-3 py-2 text-base font-semibold tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-gold" disabled={!room || disabled || saving} value={typeof value === "number" || typeof value === "string" ? value : ""} onChange={event => change("targetProfitPLN", { kind: "VALUE", value: event.target.value === "" ? null : Number(event.target.value), basis: "ASSUMPTION", evidenceUrl: null })}/></div>
        <button type="button" className="min-h-11 rounded-xl bg-gold px-4 font-semibold text-black disabled:opacity-50" disabled={disabled || saving || !room || !draft.targetProfitPLN || draft.targetProfitPLN.value === null || typeof draft.targetProfitPLN.value !== "number" || !Number.isFinite(draft.targetProfitPLN.value) || draft.targetProfitPLN.value < 0 || draft.targetProfitPLN.value > 100_000_000} onClick={() => void save()}>{saving ? "Zapisuję i przeliczam…" : "Zapisz i przelicz"}</button>
      </div>
      {stale ? <p className="text-xs text-amber-200">Założenia uległy zmianie — potwierdź tę kwotę ponownie.</p> : null}
      {notice ? <p className="text-xs font-semibold text-emerald-300" role="status">{notice}</p> : null}
      {error ? <p className="text-xs text-red-300" role="alert">{error}</p> : null}
      {!room && !disabled ? <p className="text-xs text-muted-foreground">Wczytuję zapisany cel zysku…</p> : null}
      {disabled ? <p className="text-xs text-amber-200">Zapisywanie odpowiedzi jest wyłączone.</p> : null}
      {room?.answers.targetProfitPLN?.status === "RESOLVED" ? <p className="text-xs text-muted-foreground">Cel zapisany dla tej oferty. Możesz go zmienić w dowolnym momencie.</p> : null}
    </div>;
  }
  const keys = new Set(questions.map((q) => q.field));
  const editing = Object.keys(draft).filter((field) => !keys.has(field));
  const visible = (more ? questions : questions.slice(0, 5)).concat(editing.map((field) => ({ field, question: `Edytuj odpowiedź: ${field}`, directors: "CEO", why: "Nowa runda zachowa poprzednią odpowiedź w historii.", evidence: "Deklaracja nie jest automatycznie zweryfikowanym dowodem.", blocking: false })));
  return <section data-user-questions aria-label="Dyrektorzy pytają Ciebie" className="min-w-0 space-y-4 rounded-2xl border border-gold/35 bg-gold/[0.025] p-4">
    <h2 className="text-lg font-bold text-gold">Dyrektorzy pytają Ciebie</h2>
    <p className="text-xs text-muted-foreground">Analizy regułowe Investment OS. PCC, notariusz, finansowanie i sprzedaż są scenariuszem z ustawień, a nie potwierdzonymi kosztami tej transakcji. Odpowiedź i link do dokumentu nie są automatycznym potwierdzeniem faktu prawnego ani ceny transakcyjnej. Nie wpisuj haseł, tokenów ani danych osób z dokumentów.</p>
    {disabled ? <p>Trwałe odpowiedzi nie są aktywne w tym środowisku.</p> : null}
    {visible.map((q) => { const answer = draft[q.field] ?? room?.answers[q.field], unit = answerUnit(q.field), numeric = unit !== "opis / ustalenie", stale = Boolean(room?.answers[q.field] && room.answers[q.field].sourceFingerprint !== answerSourceFingerprint(deal, q.field)); return <fieldset id={`deal-question-${q.field}`} tabIndex={-1} key={q.field} disabled={saving || !room} className="min-w-0 space-y-2 rounded-xl border border-gold/40 bg-gold/[0.05] p-3 shadow-[inset_3px_0_0_rgba(214,179,90,0.55)]" data-question-field={q.field}>
      <legend className="max-w-full break-words px-1 text-base font-bold leading-snug text-gold">{q.question}</legend>
      <p className="text-xs font-semibold text-gold/90">{q.directors} · {q.blocking ? "Pytanie blokujące" : "Założenie / dane do analizy"}</p>
      <p className="text-xs text-muted-foreground">{q.why} Potwierdzenie: {q.evidence}</p>
      <label className="block text-xs">Rodzaj odpowiedzi<select aria-label={`Rodzaj: ${q.field}`} className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={answer?.kind ?? "VALUE"} onChange={(e) => change(q.field, { kind: e.target.value as AnswerInput["kind"] })}><option value="VALUE">Podaję wartość</option><option value="UNKNOWN">Nie wiem</option><option value="LATER">Sprawdzę później</option><option value="WITHDRAW">Cofam odpowiedź</option></select></label>
      {(answer?.kind ?? "VALUE") === "VALUE" ? <>
        <label className="block text-xs">Odpowiedź ({unit}){q.field === "jdgPayments" ? <textarea aria-label={`Odpowiedź: ${q.field}`} className="mt-1 min-h-11 w-full min-w-0 rounded border bg-background p-2" rows={6} maxLength={2000} value={answer?.value ?? ""} onChange={(e)=>change(q.field,{value:e.target.value})}/> : <input aria-label={`Odpowiedź: ${q.field}`} className="mt-1 min-h-11 w-full min-w-0 rounded border bg-background p-2" type={numeric ? "number" : "text"} inputMode={numeric ? "decimal" : "text"} maxLength={2000} value={answer?.value ?? ""} onChange={(e) => change(q.field, { value: numeric && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />}</label>
        <label className="block text-xs">Podstawa<select aria-label={`Podstawa: ${q.field}`} className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={answer?.basis ?? "DECLARATION"} onChange={(e) => change(q.field, { basis: e.target.value as AnswerInput["basis"] })}><option value="DECLARATION">Moja deklaracja</option><option value="ASSUMPTION">Założenie do kalkulacji</option><option value="DOCUMENT_REFERENCE">Link do dokumentu — do weryfikacji</option></select></label>
        <label className="block text-xs">Link do dowodu (opcjonalny HTTPS, bez tokenów)<input aria-label={`Dokument: ${q.field}`} className="mt-1 min-h-11 w-full min-w-0 rounded border bg-background p-2" type="url" value={answer?.evidenceUrl ?? ""} onChange={(e) => change(q.field, { evidenceUrl: e.target.value || null })} /></label>
      </> : null}
      {stale ? <p className="text-xs text-amber-300">Źródło zmieniło się. Poprzednia odpowiedź nie jest stosowana.<button type="button" className="ml-2 min-h-11 underline" onClick={() => change(q.field, {})}>Potwierdź ponownie</button></p> : null}
      {room?.answers[q.field] ? <p className="break-words text-xs">Stan: {stale ? "Nieaktualna — wymaga potwierdzenia" : room.answers[q.field].status === "RESOLVED" ? "Założenie przyjęte do obliczeń" : "Wymaga dowodu / dalszego ustalenia"} · {room.answers[q.field].savedAt}</p> : null}
    </fieldset>; })}
    {!more && questions.length > 5 ? <button type="button" className="min-h-11 font-semibold text-gold underline underline-offset-4" onClick={() => setMore(true)}>Pozostałe pytania ({questions.length - 5})</button> : null}
    {room ? <button type="button" className="min-h-11 rounded-xl bg-gold px-4 font-semibold text-black disabled:opacity-50" disabled={saving || Object.keys(draft).length === 0} onClick={() => void save()}>{saving ? "Zapisuję i przeliczam…" : "Zapisz odpowiedzi i przelicz"}</button> : null}
    {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-emerald-300">{notice}</p> : null}
    {room && Object.keys(room.answers).length > 0 ? <details><summary className="min-h-11 cursor-pointer">Zapisane odpowiedzi — edycja i cofnięcie</summary>{Object.values(room.answers).map((a) => <article key={a.field} className="my-2 break-words rounded border p-2 text-xs"><strong>{a.field}</strong>: {a.value ?? (a.kind === "LATER" ? "Sprawdzę później" : a.kind === "WITHDRAW" ? "Cofnięto" : "Nie wiem")} · {a.basis} · {a.savedAt} · operator: {a.actorId}<button type="button" className="ml-2 min-h-11 underline" onClick={() => change(a.field, {})}>Edytuj</button><button type="button" className="ml-2 min-h-11 underline" onClick={() => change(a.field, { kind: "WITHDRAW", value: null })}>Cofnij</button></article>)}</details> : null}
    {latest ? <section aria-label="Rekomendacja przed i po odpowiedziach" className="space-y-2 border-t pt-3 text-sm"><h3 className="font-semibold">Co zmieniły odpowiedzi?</h3><p>Pola: {latest.changedFields.join(", ")}. Zależne dyrekcje: {latest.invalidated.join(", ") || "brak zmian finansowych"}.</p><p>CEO: {latest.before.ceo.decision} → {latest.after.ceo.decision} · rekomendacja warunkowa, do weryfikacji.</p><p>Zysk bazowy: {formatPLNDisplay(latest.before.financials?.profitBase ?? null)} → {formatPLNDisplay(latest.after.financials?.profitBase ?? null)}</p><p>Max Buy: {formatPLNDisplay(latest.before.financials?.maxPurchasePrice ?? null)} → {formatPLNDisplay(latest.after.financials?.maxPurchasePrice ?? null)}</p><p>{latest.after.ceo.reasoningSummary}</p><p>Runda zamknięta: {latest.after.questions.some((q) => q.category === "BLOCKING") ? "nie — pozostały pytania blokujące" : "brak otwartych pytań blokujących w projekcji; wymagane zatwierdzenie człowieka"}.</p><ol className="list-decimal pl-5">{[latest.after.ceo.nextBestAction.title, ...latest.after.ceo.conditionsToProceed].slice(0, 3).map((step, i) => <li key={i}>{step}</li>)}</ol></section> : null}
  </section>;
}
