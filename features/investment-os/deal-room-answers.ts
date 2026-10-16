import { CFO_NUMERIC, CFO_LABELS } from "./cfo";
import { buildDealBrain, DEAL_BRAIN_DEPENDENCIES } from "./brain/index.ts";
import { fingerprint } from "./engine.ts";
import type { BrainDirectorId } from "./brain/types.ts";
import type { CanonicalDeal, DealFactOverrides } from "./types.ts";

export type AnswerKind = "VALUE" | "UNKNOWN" | "LATER" | "WITHDRAW";
export type AnswerInput = { field: string; kind: AnswerKind; value: string | number | null; basis: "DECLARATION" | "ASSUMPTION" | "DOCUMENT_REFERENCE"; evidenceUrl: string | null };
export type SavedAnswer = AnswerInput & { questionId: string; actorId: string; savedAt: string; sourceFingerprint: string; status: "RESOLVED" | "NEEDS_EVIDENCE" | "OPEN"; transitions: string[] };
export type AnswerRound = { requestId: string; savedAt: string; actorId: string; changedFields: string[]; invalidated: BrainDirectorId[]; before: ReturnType<typeof buildDealBrain>; after: ReturnType<typeof buildDealBrain> };
export type DealRoomState = { version: number; answers: Record<string, SavedAnswer>; baselineOverrides: DealFactOverrides; baselineMarketObservedAt?: string; rounds: AnswerRound[] };
export type AnswerCommand = { requestId: string; expectedVersion: number; answers: AnswerInput[] };
export class DealRoomInputError extends Error {}
export class DealRoomNotFound extends Error {}
const numeric: Record<string, { min: number; max: number; unit: string }> = {
  ...Object.fromEntries(Object.entries(CFO_NUMERIC).map(([field,[min,max,unit]])=>[field,{min,max,unit}])),
  rooms: { min: 1, max: 100, unit: "liczba pokoi" },
  resalePerM2: { min: 1, max: 1000000, unit: "PLN/m² — założenie wyjścia" }, additionalCosts: { min: 0, max: 10000000, unit: "PLN dodatkowo" },
  negotiatedPrice: { min: 1, max: 100_000_000, unit: "PLN — założenie ceny zakupu" },
  askingPrice: { min: 1, max: 100_000_000, unit: "PLN" }, areaM2: { min: 1, max: 10_000, unit: "m²" },
  renovationBudget: { min: 0, max: 10_000_000, unit: "PLN łącznie, przed rezerwą" }, holdingMonths: { min: 1, max: 120, unit: "miesiące" },
};
export const ANSWER_LABELS: Record<string, string> = { ...CFO_LABELS, resalePerM2: "Jaką cenę odsprzedaży za m² przyjmujesz jako założenie?", additionalCosts: "Jakie dodatkowe koszty projektu przyjąć (PLN)?", negotiatedPrice: "Jaka jest uzgodniona cena zakupu po negocjacjach?", askingPrice: "Jaka jest aktualna cena ofertowa w źródle?", renovationBudget: "Jaki jest budżet remontu przed rezerwą (PLN łącznie)?", holdingMonths: "Ile miesięcy potrwa projekt?" };
const narrative = new Set(["financingMode", "loanSchedule", "loanSecurity", "legalStatus", "ownership", "condition", "renovationScope", "financing", "marketEvidence", "riskReview", "identity", "city", "district", "street", "rooms", "buildingType", "economics"]);
export function answerUnit(field: string): string { return numeric[field]?.unit ?? "opis / ustalenie"; }
export function parseAnswerCommand(value: unknown): AnswerCommand {
  const v = record(value);
  if (typeof v.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.requestId) || !Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 1 || !Array.isArray(v.answers) || v.answers.length < 1 || v.answers.length > 20) throw new DealRoomInputError("Nieprawidłowa wersja lub identyfikator zapisu.");
  const seen = new Set<string>();
  const answers = v.answers.map((raw): AnswerInput => {
    const a = record(raw), field = a.field;
    if (typeof field !== "string" || (!Object.hasOwn(numeric, field) && !narrative.has(field)) || seen.has(field)) throw new DealRoomInputError("Nieprawidłowe lub powtórzone pytanie.");
    if ((field in CFO_LABELS) && process.env.DEAL_ROOM_CFO_ENABLED !== "true") throw new DealRoomInputError("CFO jest wyłączony.");
    seen.add(field);
    if (!["VALUE", "UNKNOWN", "LATER", "WITHDRAW"].includes(String(a.kind)) || !["DECLARATION", "ASSUMPTION", "DOCUMENT_REFERENCE"].includes(String(a.basis))) throw new DealRoomInputError("Wybierz rodzaj odpowiedzi i jej podstawę.");
    const kind = a.kind as AnswerKind, basis = a.basis as AnswerInput["basis"];
    let result: string | number | null = null;
    if (kind === "VALUE") {
      if (numeric[field]) {
        if (typeof a.value !== "number" || !Number.isFinite(a.value) || a.value < numeric[field].min || a.value > numeric[field].max || (["rooms","renovationMonths","loanTermMonths"].includes(field) && !Number.isInteger(a.value))) throw new DealRoomInputError(`Podaj poprawną wartość: ${answerUnit(field)}.`);
        result = a.value;
      } else {
        if (typeof a.value !== "string" || !a.value.trim() || a.value.length > 2000) throw new DealRoomInputError("Odpowiedź musi mieć od 1 do 2000 znaków.");
        result = a.value.trim();
        if (field === "financingMode" && !["CASH","LOAN","INVESTOR"].includes(result)) throw new DealRoomInputError("Wybierz CASH, LOAN lub INVESTOR.");
        if (field === "loanSchedule" && !["INTEREST_ONLY","ANNUITY"].includes(result)) throw new DealRoomInputError("Wybierz INTEREST_ONLY lub ANNUITY.");
        if (/-----BEGIN .*PRIVATE KEY|\b(?:Bearer\s+|sk-proj-|sb_secret_|gh[pousr]_|(?:cookie|authorization|access_token|refresh_token)\s*[:=])/i.test(result)) throw new DealRoomInputError("Nie zapisuj sekretów ani tokenów w odpowiedziach.");
      }
    }
    let evidenceUrl: string | null = null;
    if (a.evidenceUrl != null && a.evidenceUrl !== "") {
      if (typeof a.evidenceUrl !== "string" || a.evidenceUrl.length > 500) throw new DealRoomInputError("Nieprawidłowy link do dokumentu.");
      try { const url = new URL(a.evidenceUrl); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw Error(); evidenceUrl = url.href; } catch { throw new DealRoomInputError("Link musi używać HTTPS, bez hasła, tokenów i parametrów. Nie pobieramy dokumentu automatycznie."); }
    }
    if (basis === "DOCUMENT_REFERENCE" && kind === "VALUE" && !evidenceUrl) throw new DealRoomInputError("Dodaj link do dokumentu albo wybierz deklarację.");
    return { field, kind, value: result, basis, evidenceUrl };
  });
  return { requestId: v.requestId, expectedVersion: Number(v.expectedVersion), answers };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function answerSourceFingerprint(deal: CanonicalDeal, field: string): string {
  const fact = deal.facts[(field === "negotiatedPrice" ? "askingPrice" : field) as keyof typeof deal.facts];
  return fingerprint({ field, source: fact ? { value: fact.sourceValue, evidence: fact.sourceEvidenceIds } : field === "renovationBudget" ? { area: deal.facts.areaM2.sourceValue, condition: deal.facts.condition.sourceValue } : { source: deal.facts.sourceUrl.sourceValue } });
}
export function affectedDirectors(fields: string[]): BrainDirectorId[] {
  const aliases: Record<string, string> = { renovationBudget: "renovationAssumption", holdingMonths: "transactionCosts", renovationScope: "renovationAssumption", negotiatedPrice: "askingPrice", resalePerM2: "marketEvidence", additionalCosts: "transactionCosts" };
  const changed = fields.map((field) => field in CFO_LABELS ? "financing" : aliases[field] ?? field), result = new Set<BrainDirectorId>();
  for (const node of DEAL_BRAIN_DEPENDENCIES) if (node.dependsOnFields.some((field) => changed.includes(field)) || node.dependsOnDirectors.some((id) => result.has(id))) result.add(node.director);
  return [...result];
}
export function mergeAnswers(deal: CanonicalDeal, state: DealRoomState, command: AnswerCommand, actorId: string, now: string): Record<string, SavedAnswer> {
  const result = { ...state.answers };
  for (const answer of command.answers) {
    const numericValue = Boolean(numeric[answer.field]) || ["financingMode","loanSchedule"].includes(answer.field);
    result[answer.field] = { ...answer, questionId: `brain-question:${deal.id}:${answer.field}`, actorId, savedAt: now, sourceFingerprint: answerSourceFingerprint(deal, answer.field), status: answer.kind !== "VALUE" ? "OPEN" : numericValue ? "RESOLVED" : "NEEDS_EVIDENCE", transitions: answer.kind !== "VALUE" ? ["OPEN"] : ["OPEN", "ANSWERED", numericValue ? "RESOLVED" : "NEEDS_EVIDENCE"] };
  }
  return result;
}
export function answerOverrides(deal: CanonicalDeal, baseline: DealFactOverrides, answers: Record<string, SavedAnswer>): DealFactOverrides {
  const result = { ...baseline };
  for (const [field, answer] of Object.entries(answers)) {
    if (answer.kind !== "VALUE" || answer.sourceFingerprint !== answerSourceFingerprint(deal, field)) continue;
    if (field in CFO_LABELS) Object.assign(result,{[field]:answer.value});
    if ((field === "askingPrice" || field === "areaM2" || field === "holdingMonths" || field === "negotiatedPrice" || field === "resalePerM2" || field === "additionalCosts" || field === "rooms") && typeof answer.value === "number") result[field] = answer.value;
    if ((field === "city" || field === "district" || field === "street" || field === "ownership" || field === "condition" || field === "buildingType") && typeof answer.value === "string") result[field] = answer.value;
  }
  const budget = answers.renovationBudget, area = typeof result.areaM2 === "number" ? result.areaM2 : deal.facts.areaM2.sourceValue;
  if (budget?.kind === "VALUE" && budget.sourceFingerprint === answerSourceFingerprint(deal, "renovationBudget") && typeof budget.value === "number") {
    if (!area || area <= 0) throw new DealRoomInputError("Potwierdź metraż przed zapisaniem całkowitego kosztu remontu.");
    result.renovationPerM2 = budget.value / area;
    result.renovationTotal = budget.value;
  }
  return result;
}
export function preserveUnchangedDirectors(previous: CanonicalDeal, next: CanonicalDeal): CanonicalDeal {
  // Rebuilding calculations must not erase independently attached document evidence.
  next.evidenceFabric = [...new Map([...previous.evidenceFabric, ...next.evidenceFabric].map((item) => [item.id, item])).values()];
  for (const key of ["scout", "verify", "market", "underwriting", "ceo"] as const) {
    const semantic = (output: CanonicalDeal[typeof key]) => fingerprint({ result: output.result, status: output.status, confidence: output.confidence, provenance: output.provenance, warnings: output.warnings, missing: output.missingFields, validation: output.validation.checks, freshUntil: output.freshUntil });
    if (previous[key].inputFingerprint === next[key].inputFingerprint && semantic(previous[key]) === semantic(next[key])) {
      // Preserve the actual typed track, including timestamps, when its inputs did not change.
      switch (key) {
        case "scout": next.scout = previous.scout; break;
        case "verify": next.verify = previous.verify; break;
        case "market": next.market = previous.market; break;
        case "underwriting": next.underwriting = previous.underwriting; break;
        case "ceo": next.ceo = previous.ceo; break;
      }
    }
  }
  return next;
}
export function roomQuestions(deal: CanonicalDeal, state: DealRoomState) {
  const questions = buildDealBrain(deal).questions.map((q) => ({ field: q.field, question: q.question, why: q.whyItMatters, evidence: q.evidenceNeeded, directors: q.requestingDirectors.join(", "), blocking: q.category === "BLOCKING" }));
  for (const field of ["negotiatedPrice", "renovationBudget", "holdingMonths", "financing", "resalePerM2", "additionalCosts"]) if (!questions.some((q) => q.field === field)) questions.push({ field, question: ANSWER_LABELS[field] ?? "Jakie źródło kapitału i warunki finansowania potwierdzono?", why: field === "negotiatedPrice" ? `Cena ofertowa w źródle: ${deal.facts.askingPrice.sourceValue ?? "brak danych"} PLN. Kwota po negocjacjach pozostaje odrębnym założeniem zakupu.` : "Zmiana założenia może zmienić wynik i warunki decyzji.", evidence: "Potwierdzenie sprzedającego, kosztorys lub warunki finansowania; deklaracja nie stanowi dowodu.", directors: field === "renovationBudget" ? "RENOVATION, UNDERWRITER, CEO" : "CFO, ACQUISITION, CEO", blocking: false });
  if (deal.underwriting.result?.cfo) for(const field of deal.underwriting.result.cfo.missing) if(CFO_LABELS[field] && !questions.some(q=>q.field===field)) questions.push({field,question:CFO_LABELS[field],why:"Kapitał, koszt finansowania i warunki CEO zależą od tej deklaracji.",evidence:"Deklaracja lub dokument warunków; nie potwierdzenie bankowe.",directors:"CFO, UNDERWRITER, ACQUISITION, CEO",blocking:true});
  return questions.filter((q) => !(deal.underwriting.result?.cfo && q.field === "financing") && (!state.answers[q.field] || state.answers[q.field].status !== "RESOLVED" || state.answers[q.field].sourceFingerprint !== answerSourceFingerprint(deal, q.field)));
}
