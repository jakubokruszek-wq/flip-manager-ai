import type { CanonicalDeal, InformationRequest } from "../types.ts";
import { BRAIN_DIRECTORS, type BrainDirector, type BrainDirectorId, type BrainQuestion, type BrainQuestionCategory } from "./types.ts";

const SPEC: Record<string, { question: string; why: string; evidence: string; metrics: string[]; decision: InformationRequest["decisionImpact"] }> = {
  legalStatus: { question: "Czy możesz udostępnić numer księgi wieczystej lub dokument potwierdzający stan prawny?", why: "Bez dowodu prawnego kanoniczna bramka zakupu pozostaje zamknięta; brak dokumentu nie oznacza wykrytej wady.", evidence: "Księga wieczysta, dokument własności lub ocena uprawnionego specjalisty.", metrics: ["Bramka zakupu", "Decyzja CEO"], decision: ["HOLD", "BUY", "REJECT"] },
  ownership: { question: "Jaka jest forma własności i jaki dokument ją potwierdza?", why: "Forma własności wpływa na możliwość bezpiecznego przeprowadzenia transakcji.", evidence: "Dokument własności lub właściwy dokument spółdzielczy.", metrics: ["Bramka zakupu", "Ryzyko prawne"], decision: ["HOLD", "BUY", "REJECT"] },
  askingPrice: { question: "Jaka jest aktualna cena ofertowa i jaki zakres negocjacji dopuszcza sprzedający?", why: "Cena jest porównywana z istniejącym limitem zakupu i kanoniczną ekonomią.", evidence: "Aktualne potwierdzenie ceny od sprzedającego.", metrics: ["Maksymalna cena zakupu", "Zysk", "ROI"], decision: ["NEGOTIATE", "BUY", "REJECT"] },
  marketEvidence: { question: "Czy mamy aktualne, porównywalne oferty lub dane transakcyjne dla tej lokalizacji?", why: "Wartość wyjścia i wynik finansowy zależą od jakości dostępnych porównań.", evidence: "Zidentyfikowane porównania z lokalizacją, datą i źródłem lub dane transakcyjne.", metrics: ["Wartość wyjścia", "Maksymalna cena zakupu", "Zysk", "ROI"], decision: ["HOLD", "NEGOTIATE", "BUY"] },
  areaM2: { question: "Jaki metraż wynika z dokumentu lub bezpośrednio potwierdzonego źródła?", why: "Metraż wpływa na porównania rynkowe, budżet remontu i kalkulację.", evidence: "Dokument lokalu lub dokładne potwierdzenie źródłowe.", metrics: ["Wartość wyjścia", "Budżet remontu", "Maksymalna cena zakupu"], decision: ["HOLD", "NEGOTIATE", "BUY", "REJECT"] },
  city: { question: "Jaka lokalizacja jest potwierdzona dla tej oferty?", why: "Rynek porównawczy zależy od prawidłowego miasta i lokalizacji.", evidence: "Kanoniczny adres lub wiarygodny dokument lokalizacyjny.", metrics: ["Wartość wyjścia", "Porównania rynkowe"], decision: ["HOLD", "REJECT"] },
  district: { question: "Czy możesz potwierdzić dzielnicę lub najbliższe skrzyżowanie?", why: "Doprecyzowanie lokalizacji pomaga ocenić porównywalność rynku.", evidence: "Dokładna lokalizacja w ogłoszeniu lub potwierdzenie sprzedającego.", metrics: ["Porównania rynkowe"], decision: ["HOLD", "NEGOTIATE"] },
  street: { question: "Jaki dokładny adres można potwierdzić przed oględzinami?", why: "Adres umożliwia sprawdzenie lokalizacji i dopasowania dowodów rynkowych.", evidence: "Potwierdzenie sprzedającego lub dokument lokalu.", metrics: ["Porównania rynkowe", "Weryfikacja oferty"], decision: ["HOLD", "NEGOTIATE"] },
  rooms: { question: "Ile pokoi jest w aktualnym układzie lokalu?", why: "Liczba pokoi jest cechą dopasowania porównań, nie założeniem po przebudowie.", evidence: "Rzut lokalu lub bezpośrednie potwierdzenie aktualnego układu.", metrics: ["Porównania rynkowe"], decision: ["HOLD", "NEGOTIATE"] },
  buildingType: { question: "Jaki typ budynku i rok budowy można potwierdzić?", why: "Typ i wiek budynku wpływają na dobór porównań oraz ryzyka nieruchomości.", evidence: "Dokument budynku, rzut lub wiarygodne źródło publiczne.", metrics: ["Porównania rynkowe", "Ryzyko nieruchomości"], decision: ["HOLD", "NEGOTIATE"] },
  condition: { question: "Jaki stan instalacji i wykończenia potwierdzają oględziny?", why: "Model remontu jest estymacją, dopóki stan i zakres prac nie są potwierdzone.", evidence: "Oględziny, zdjęcia źródłowe lub kosztorys wykonawcy.", metrics: ["Budżet remontu", "Zysk", "Maksymalna cena zakupu"], decision: ["HOLD", "NEGOTIATE", "BUY"] },
  renovationScope: { question: "Jaki zakres prac potwierdzono podczas oględzin lub w kosztorysie?", why: "Niepotwierdzony zakres może zmienić koszt i scenariusz finansowy.", evidence: "Protokół oględzin albo kosztorys wykonawcy.", metrics: ["Budżet remontu", "Zysk", "ROI"], decision: ["HOLD", "NEGOTIATE", "BUY"] },
  identity: { question: "Jaki kanoniczny identyfikator potwierdza, że analizujemy właściwe ogłoszenie?", why: "Bez potwierdzonej tożsamości pozostałe fakty mogą dotyczyć innej oferty.", evidence: "Dokładny permalink i identyfikator źródłowy.", metrics: ["Wiarygodność danych", "Decyzja CEO"], decision: ["HOLD", "REJECT"] },
  riskReview: { question: "Który nierozstrzygnięty konflikt lub dokument wymaga przeglądu przed zakupem?", why: "Kanoniczna ocena nie pozwala zamknąć ryzyka bez wyjaśnienia wskazanej pozycji.", evidence: "Dowód pierwotny rozstrzygający konflikt albo udokumentowany przegląd.", metrics: ["Bramka zakupu", "Decyzja CEO"], decision: ["HOLD", "REJECT", "BUY"] },
  economics: { question: "Czy wszystkie kanoniczne kontrole finansowe przeszły walidację?", why: "Decyzja nie powinna opierać się na niewalidowanym wyniku finansowym.", evidence: "Istniejący wynik Investment OS ze wszystkimi kontrolami.", metrics: ["Zysk", "ROI", "Maksymalna cena zakupu"], decision: ["HOLD", "NEGOTIATE", "BUY"] },
  financing: { question: "Z jakiego źródła ma pochodzić kapitał i jakie warunki finansowania są potwierdzone?", why: "CanonicalDeal nie zawiera jawnej struktury finansowania; nie dopisujemy kosztu kredytu ani wkładu własnego.", evidence: "Potwierdzona struktura kapitału lub warunki finansowania.", metrics: ["Kapitał wymagany", "Koszty finansowania"], decision: ["HOLD", "BUY"] },
};

const DIRECTOR_CONSUMERS: Record<string, BrainDirectorId[]> = {
  legalStatus: ["VERIFY", "RISK_LEGAL", "ACQUISITION", "CEO"],
  ownership: ["VERIFY", "RISK_LEGAL", "ACQUISITION", "CEO"],
  askingPrice: ["SCOUT", "VERIFY", "UNDERWRITER", "ACQUISITION", "CEO"],
  marketEvidence: ["MARKET", "SALE", "UNDERWRITER", "CFO", "ACQUISITION", "CEO"],
  areaM2: ["SCOUT", "VERIFY", "MARKET", "RENOVATION", "UNDERWRITER", "SALE", "CEO"],
  city: ["SCOUT", "VERIFY", "MARKET", "SALE", "CEO"],
  district: ["SCOUT", "VERIFY", "MARKET", "SALE", "CEO"],
  street: ["SCOUT", "VERIFY", "MARKET", "SALE", "CEO"],
  rooms: ["SCOUT", "VERIFY", "MARKET", "SALE", "CEO"],
  buildingType: ["SCOUT", "VERIFY", "MARKET", "RENOVATION", "RISK_LEGAL", "SALE", "CEO"],
  condition: ["VERIFY", "RENOVATION", "UNDERWRITER", "RISK_LEGAL", "CFO", "CEO"],
  renovationScope: ["VERIFY", "RENOVATION", "UNDERWRITER", "CFO", "CEO"],
  identity: ["SCOUT", "VERIFY", "RISK_LEGAL", "ACQUISITION", "CEO"],
  riskReview: ["VERIFY", "RISK_LEGAL", "ACQUISITION", "CEO"],
  economics: ["UNDERWRITER", "CFO", "ACQUISITION", "CEO"],
  financing: ["CFO", "UNDERWRITER", "CEO"],
};

const PRIORITY_ORDER: Record<InformationRequest["priority"], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const CATEGORY_ORDER: Record<BrainQuestionCategory, number> = { BLOCKING: 0, DECISION_CHANGING: 1, USEFUL: 2 };

export function buildBrainQuestions(deal: CanonicalDeal, directors: Partial<Record<BrainDirectorId, BrainDirector>>): BrainQuestion[] {
  const requests = new Map<string, InformationRequest>();
  const addRequest = (request: InformationRequest) => {
    if (request.status !== "OPEN" || !SPEC[request.field]) return;
    const current = requests.get(request.field);
    if (!current || PRIORITY_ORDER[request.priority] < PRIORITY_ORDER[current.priority] || request.valueOfInformation > current.valueOfInformation) requests.set(request.field, request);
  };
  deal.informationRequests.forEach(addRequest);
  deal.ceo.result?.nextBestQuestions.forEach(addRequest);

  for (const gate of deal.ceo.result?.criticalGates ?? []) {
    if (gate.passed || !SPEC[gate.fact] || requests.has(gate.fact)) continue;
    requests.set(gate.fact, {
      id: `brain-question:${deal.id}:${gate.fact}`, field: gate.fact, question: SPEC[gate.fact].question, priority: "CRITICAL",
      valueOfInformation: 0, decisionImpact: SPEC[gate.fact].decision, requestedBy: gate.fact === "legalStatus" || gate.fact === "ownership" ? "LEGAL" : "VERIFY",
      evidenceNeeded: SPEC[gate.fact].evidence, status: "OPEN",
    });
  }

  const verified = deal.verify.result;
  for (const field of [...(verified?.missingCriticalFields ?? []), ...(verified?.missingOptionalFields ?? [])]) {
    if (!SPEC[field] || requests.has(field)) continue;
    const critical = verified?.missingCriticalFields.includes(field) ?? false;
    requests.set(field, {
      id: `brain-question:${deal.id}:${field}`, field, question: SPEC[field].question, priority: critical ? "HIGH" : "MEDIUM", valueOfInformation: 0,
      decisionImpact: SPEC[field].decision, requestedBy: "VERIFY", evidenceNeeded: SPEC[field].evidence, status: "OPEN",
    });
  }

  const questions = [...requests.values()].map((request): BrainQuestion => {
    const spec = SPEC[request.field];
    const gateBlocks = deal.ceo.result?.criticalGates.some((gate) => gate.fact === request.field && !gate.passed) ?? false;
    const category: BrainQuestionCategory = gateBlocks || request.priority === "CRITICAL" ? "BLOCKING" : request.priority === "HIGH" ? "DECISION_CHANGING" : "USEFUL";
    const consumers = DIRECTOR_CONSUMERS[request.field] ?? [];
    const requestingDirectors = BRAIN_DIRECTORS.filter((id) => consumers.includes(id) && Boolean(directors[id]));
    return {
      id: `brain-question:${deal.id}:${request.field}`,
      field: request.field,
      category,
      priority: request.priority,
      question: spec.question,
      whyItMatters: spec.why,
      requestingDirectors,
      affectedDecision: [...request.decisionImpact],
      affectedMetrics: [...spec.metrics],
      evidenceNeeded: request.evidenceNeeded || spec.evidence,
      valueOfInformation: request.valueOfInformation > 0 ? request.valueOfInformation : null,
    };
  });

  return questions.sort((left, right) => CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    || PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
    || (right.valueOfInformation ?? -1) - (left.valueOfInformation ?? -1)
    || left.field.localeCompare(right.field, "en"));
}
