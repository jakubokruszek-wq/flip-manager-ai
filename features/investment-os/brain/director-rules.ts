import type { CanonicalDeal, DealFacts, DirectorOutput, FactValue, ProvenanceEntry } from "../types.ts";
import { dependenciesFor } from "./dependency-graph.ts";
import type { BrainConfidenceState, BrainDirector, BrainDirectorId, BrainDirectorStatus, BrainFreshness, BrainMetric, BrainProvenance, BrainRisk } from "./types.ts";

const FIELD_LABELS: Record<string, string> = {
  askingPrice: "cena ofertowa", askingPricePerM2: "cena za metr kwadratowy", areaM2: "powierzchnia", rooms: "liczba pokoi",
  city: "miasto", district: "dzielnica", street: "dokładny adres", floor: "piętro", floorsTotal: "liczba pięter",
  buildingType: "typ budynku", ownership: "forma własności", condition: "stan lokalu", monthlyFee: "czynsz", yearBuilt: "rok budowy",
  source: "źródło ogłoszenia", sourceUrl: "kanoniczny link", postId: "identyfikator ogłoszenia", imageCount: "liczba zdjęć",
  identity: "dokładna tożsamość ogłoszenia", legalStatus: "stan prawny", marketEvidence: "dowody rynkowe", renovationScope: "zakres remontu",
  economics: "zwalidowana ekonomika", riskReview: "przegląd ryzyka", financing: "struktura finansowania",
};

const SOURCE_OUTPUTS: Partial<Record<BrainDirectorId, keyof CanonicalDeal>> = {
  SCOUT: "scout", VERIFY: "verify", MARKET: "market", UNDERWRITER: "underwriting", CEO: "ceo",
};

export function buildBaseBrainDirectors(deal: CanonicalDeal, conflicts: BrainRisk[]): Partial<Record<BrainDirectorId, BrainDirector>> {
  const ordered: Partial<Record<BrainDirectorId, BrainDirector>> = {};
  const directFreshness = directFreshnessFor(deal);

  for (const id of ["SCOUT", "VERIFY", "MARKET", "RENOVATION", "UNDERWRITER", "RISK_LEGAL", "CFO", "ACQUISITION", "SALE"] as const) {
    const upstream = dependenciesFor(id).map((dependency) => ordered[dependency]).filter((item): item is BrainDirector => Boolean(item));
    const freshness = propagateFreshness(directFreshness[id], upstream.map((item) => item.freshness));
    const propagatedWarnings = upstream.filter((item) => item.status !== "READY" || item.freshness !== "CURRENT").map((item) => `${item.id}: ${item.freshness === "STALE" ? "wynik nieaktualny" : item.status === "BLOCKED" ? "wynik zablokowany" : item.status === "NEEDS_DATA" ? "brakuje danych" : "aktualność niepotwierdzona"}.`);
    ordered[id] = makeDirector(deal, id, freshness, propagatedWarnings, conflicts);
  }
  return ordered;
}

function makeDirector(deal: CanonicalDeal, id: BrainDirectorId, freshness: BrainFreshness, propagatedWarnings: string[], conflicts: BrainRisk[]): BrainDirector {
  switch (id) {
    case "SCOUT": return scout(deal, freshness, propagatedWarnings);
    case "VERIFY": return verify(deal, freshness, propagatedWarnings);
    case "MARKET": return market(deal, freshness, propagatedWarnings);
    case "RENOVATION": return renovation(deal, freshness, propagatedWarnings);
    case "UNDERWRITER": return underwriter(deal, freshness, propagatedWarnings);
    case "RISK_LEGAL": return riskLegal(deal, freshness, propagatedWarnings, conflicts);
    case "CFO": return cfo(deal, freshness, propagatedWarnings);
    case "ACQUISITION": return acquisition(deal, freshness, propagatedWarnings, conflicts);
    case "SALE": return sale(deal, freshness, propagatedWarnings);
    case "CEO": throw new Error("CEO_DIRECTOR_BUILT_BY_SYNTHESIS");
  }
}

function scout(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const fields = ["askingPrice", "areaM2", "rooms", "city", "district", "street", "buildingType", "floor", "floorsTotal"] as const;
  const missing = fields.filter((field) => deal.facts[field].effectiveValue == null).map(label);
  const evidence = fields.map((field) => factProvenance(field, deal.facts[field])).filter((item) => item.evidenceState !== "MISSING");
  const location = [deal.facts.city.effectiveValue, deal.facts.district.effectiveValue].filter(Boolean).join(" · ") || null;
  const title = deal.facts.street.effectiveValue ?? deal.facts.district.effectiveValue ?? "Oferta bez dokładnego adresu";
  const status = missing.length ? "NEEDS_DATA" : "READY";
  return output(deal, "SCOUT", status, "Profil oferty", missing.length ? `Profil „${title}” ma nieuzupełnione pola: ${missing.join(", ")}.` : `Zebrano kanoniczne dane oferty „${title}” w ${location ?? "nieustalonej lokalizacji"}.`, missing.length ? "Uzupełnij brakujące fakty z wiarygodnego źródła; nie dopowiadaj ich z kontekstu." : "Przekaż zapisane fakty do weryfikacji.", [
    metric(deal, "askingPrice", "Cena ofertowa", deal.facts.askingPrice.effectiveValue, factProvenance("askingPrice", deal.facts.askingPrice), "PLN"),
    metric(deal, "areaM2", "Powierzchnia", deal.facts.areaM2.effectiveValue, factProvenance("areaM2", deal.facts.areaM2), "M2"),
    metric(deal, "rooms", "Liczba pokoi", deal.facts.rooms.effectiveValue, factProvenance("rooms", deal.facts.rooms), "ROOMS"),
    metric(deal, "location", "Lokalizacja", location, combineProvenance([factProvenance("city", deal.facts.city), factProvenance("district", deal.facts.district)])),
    metric(deal, "buildingType", "Typ budynku", deal.facts.buildingType.effectiveValue, factProvenance("buildingType", deal.facts.buildingType)),
    metric(deal, "imageCount", "Liczba zdjęć", deal.facts.imageCount.effectiveValue, factProvenance("imageCount", deal.facts.imageCount), "COUNT"),
  ], missing, [...inheritedWarnings, ...(deal.facts.imageCount.effectiveValue === 0 ? ["Brak zdjęć nie zmienia decyzji ani wyniku finansowego."] : [])], evidence, evidence.length ? evidence : [factProvenance("source", deal.facts.source)], freshness, "Scout opisuje tylko zapisane fakty ogłoszenia.");
}

function verify(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const result = deal.verify.result;
  const missing = unique([...(result?.missingCriticalFields ?? []), ...(result?.missingOptionalFields ?? [])]);
  const conflicts = result?.conflicts ?? [];
  const status: BrainDirectorStatus = conflicts.length ? "BLOCKED" : missing.length || result?.verificationStatus !== "VERIFIED" ? "NEEDS_DATA" : "READY";
  const evidence = provenanceEntries(deal.verify.provenance);
  return output(deal, "VERIFY", status, conflicts.length ? "Wykryto konflikt faktów" : status === "READY" ? "Fakty spełniają zapisane kontrole" : "Weryfikacja wymaga uzupełnienia", conflicts.length ? `Kanoniczna weryfikacja wskazuje: ${conflicts.join(", ")}.` : missing.length ? `Do potwierdzenia: ${missing.map(label).join(", ")}.` : "Tożsamość i dostępne fakty przechodzą kontrole zapisane w CanonicalDeal.", conflicts.length ? "Rozstrzygnij konflikt dowodami źródłowymi; nie wybieraj jednej wartości arbitralnie." : missing.length ? "Pozyskaj wskazane dokumenty lub bezpośrednie potwierdzenia." : "Zachowaj źródła i ponów weryfikację po istotnej zmianie.", [
    metric(deal, "identity", "Tożsamość źródła", deal.facts.postId.effectiveValue, factProvenance("postId", deal.facts.postId)),
    metric(deal, "verificationStatus", "Wynik weryfikacji", result?.verificationStatus ?? null, provenance("verify.result.verificationStatus", deal.verify.inputFingerprint, "FACT", deal.verify.computedAt)),
    metric(deal, "conflictCount", "Konflikty faktów", conflicts.length, provenance("verify.result.conflicts", deal.verify.inputFingerprint, "FACT", deal.verify.computedAt), "COUNT"),
  ], missing, [...inheritedWarnings, ...deal.verify.warnings], evidence, evidence.length ? evidence : [provenance("verify.result", deal.verify.inputFingerprint, null, deal.verify.computedAt)], freshness, "Weryfikacja wykorzystuje wynik kanonicznego walidatora, konfliktów i pochodzenia faktów.");
}

function market(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const result = deal.market.result;
  const failedChecks = deal.market.validation.checks.filter((check) => !check.passed).map((check) => check.code);
  const stale = failedChecks.includes("MARKET_EVIDENCE_FRESH") || freshness === "STALE";
  const needsData = !result || result.fallbackLevel > 0 || result.compCount === 0 || result.priceEvidenceType === "USER_ASSUMPTION";
  const status: BrainDirectorStatus = stale || (failedChecks.length > 0 && !failedChecks.every((code) => ["RESALE_ASSUMPTION_MISSING", "MARKET_AREA_MISSING", "MARKET_VERIFY_BLOCKED"].includes(code))) ? "BLOCKED" : needsData ? "NEEDS_DATA" : "READY";
  const missing = unique([...(deal.market.missingFields ?? []), ...(!result ? ["marketEvidence"] : [])]);
  const evidence = provenanceEntries(deal.market.provenance);
  const explanation = result
    ? `Kanoniczny przedział wartości wyjścia wynosi ${result.resaleValueLow}–${result.resaleValueHigh} zł; baza ${result.resaleValueBase} zł. Źródło: ${result.compCount} porównań, typ ${result.priceEvidenceType.toLowerCase().replaceAll("_", " ")}.`
    : "Nie ma wystarczającego kanonicznego wyniku rynku do podania wartości odsprzedaży.";
  return output(deal, "MARKET", status, result ? "Dostępny wynik rynku" : "Brak użytecznego wyniku rynku", explanation, stale ? "Odśwież dowody rynkowe przed użyciem wartości wyjścia." : needsData ? "Uzupełnij istniejące dane porównawcze; nie twórz porównań zastępczych." : "Przekaż kanoniczny przedział do underwritingu i oceny sprzedaży.", result ? [
    metric(deal, "resalePricePerM2Base", "Cena wyjścia za m² — baza", result.resalePricePerM2Base, provenance("market.result.resalePricePerM2Base", result.evidenceId, result.priceEvidenceType === "USER_ASSUMPTION" ? "ASSUMPTION" : "ESTIMATE", result.observedAt), "PLN_PER_M2"),
    metric(deal, "resaleValueLow", "Wartość wyjścia — dół przedziału", result.resaleValueLow, provenance("market.result.resaleValueLow", result.evidenceId, "ESTIMATE", result.observedAt), "PLN"),
    metric(deal, "resaleValueBase", "Wartość wyjścia — baza", result.resaleValueBase, provenance("market.result.resaleValueBase", result.evidenceId, "ESTIMATE", result.observedAt), "PLN"),
    metric(deal, "resaleValueHigh", "Wartość wyjścia — góra przedziału", result.resaleValueHigh, provenance("market.result.resaleValueHigh", result.evidenceId, "ESTIMATE", result.observedAt), "PLN"),
    metric(deal, "comparableCount", "Liczba porównań", result.compCount, provenance("market.result.compCount", result.evidenceId, "FACT", result.observedAt), "COUNT"),
  ] : [], missing, [...inheritedWarnings, ...(result ? [result.fallbackReason].filter((value): value is string => Boolean(value)) : deal.market.reasonCodes)], evidence, evidence.length ? evidence : [provenance("market.validation", deal.market.inputFingerprint, null, deal.market.computedAt)], freshness, result ? "Wartości pochodzą z istniejącego wyniku MARKET i jego provenance." : "Nie utworzono wartości ARV bez kanonicznego dowodu.");
}

function renovation(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const result = deal.underwriting.result;
  const conditionUnknown = deal.facts.condition.effectiveValue == null || deal.facts.condition.freshness === "STALE";
  const missing = result ? (conditionUnknown ? ["condition", "renovationScope"] : []) : ["marketEvidence", "renovationEstimate"];
  const status: BrainDirectorStatus = result ? conditionUnknown ? "NEEDS_DATA" : "READY" : "NEEDS_DATA";
  const evidence = [factProvenance("condition", deal.facts.condition), factProvenance("areaM2", deal.facts.areaM2), ...provenanceEntries(deal.underwriting.provenance.filter((item) => ["renovationPerM2", "renovationTotal"].includes(item.field)))].filter((item) => item.evidenceState !== "MISSING");
  const rangeLow = result?.scenarios.optimistic.renovationTotal ?? null;
  const rangeHigh = result?.scenarios.conservative.renovationTotal ?? null;
  return output(deal, "RENOVATION", status, result ? "Zakres według kanonicznego modelu" : "Koszt remontu niedostępny", result ? conditionUnknown ? "Model podaje koszt przy niepotwierdzonym stanie lokalu; traktuj go jako założenie, nie kosztorys." : `Model kanoniczny przyjął zakres ${result.renovationMode.toLowerCase()} i koszt bazowy ${result.renovationTotal ?? "nieustalony"} zł.` : "Brakuje wyniku kanonicznego underwritingu; nie uruchomiono drugiego kalkulatora remontu.", conditionUnknown ? "Potwierdź stan lokalu i zakres oględzinami lub kosztorysem." : "Porównaj model ze stanem potwierdzonym podczas oględzin.", result ? [
    metric(deal, "renovationMode", "Przyjęty zakres", result.renovationMode, provenance("underwriting.result.renovationMode", `deal:${deal.id}:underwriting`, "ASSUMPTION", deal.underwriting.computedAt)),
    metric(deal, "renovationPerM2", "Koszt na m²", result.renovationPerM2, provenance("underwriting.result.renovationPerM2", `deal:${deal.id}:underwriting`, "ASSUMPTION", deal.underwriting.computedAt), "PLN_PER_M2"),
    metric(deal, "renovationTotal", "Koszt bazowy", result.renovationTotal, provenance("underwriting.result.renovationTotal", `deal:${deal.id}:underwriting`, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
    metric(deal, "renovationRangeLow", "Dolna wartość scenariusza", rangeLow, provenance("underwriting.result.scenarios.optimistic.renovationTotal", `deal:${deal.id}:underwriting`, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
    metric(deal, "renovationRangeHigh", "Górna wartość scenariusza", rangeHigh, provenance("underwriting.result.scenarios.conservative.renovationTotal", `deal:${deal.id}:underwriting`, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
  ] : [], missing, [...inheritedWarnings, ...(conditionUnknown && result ? ["Stan lokalu jest brakujący lub nieaktualny; przedział modelu nie jest ofertą wykonawcy."] : [])], evidence, evidence.length ? evidence : [provenance("underwriting.result", deal.underwriting.inputFingerprint, null, deal.underwriting.computedAt)], freshness, "Koszt, tryb i scenariusze pochodzą bezpośrednio z kanonicznego underwritingu.");
}

function underwriter(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const sourceOutput = deal.underwriting;
  const result = sourceOutput.result;
  const hardValidationFailure = sourceOutput.validation.status === "FAIL";
  const missing = result?.missingFields ?? sourceOutput.missingFields;
  const status: BrainDirectorStatus = hardValidationFailure ? "BLOCKED" : !result ? "NEEDS_DATA" : missing.length ? "NEEDS_DATA" : "READY";
  const evidence = provenanceEntries(sourceOutput.provenance);
  return output(deal, "UNDERWRITER", status, result ? "Wynik kanonicznego silnika finansowego" : "Brak zwalidowanego wyniku finansowego", result ? "Wyniki i scenariusze poniżej są odczytane z zapisanego Investment OS; brain nie przelicza ich ponownie." : "Kalkulacja nie ma kompletnych, zwalidowanych wejść w CanonicalDeal.", hardValidationFailure ? "Usuń przyczynę nieudanej walidacji w istniejącym przepływie analizy." : missing.length ? `Uzupełnij: ${missing.map(label).join(", ")}.` : "Użyj limitu i wyniku tylko razem z bramkami CEO oraz ryzykiem prawnym.", result ? [
    metric(deal, "purchasePrice", "Cena zakupu przyjęta przez silnik", result.purchasePrice, provenance("underwriting.result.purchasePrice", sourceOutput.inputFingerprint, result.provenance.askingPrice === "UNKNOWN" ? null : result.provenance.askingPrice === "DERIVED" ? "ESTIMATE" : "FACT", sourceOutput.computedAt), "PLN"),
    metric(deal, "profitBase", "Zysk bazowy", result.profitBase, provenance("underwriting.result.profitBase", sourceOutput.inputFingerprint, "ESTIMATE", sourceOutput.computedAt), "PLN"),
    metric(deal, "roiBase", "Zwrot z inwestycji", result.roiBase, provenance("underwriting.result.roiBase", sourceOutput.inputFingerprint, "ESTIMATE", sourceOutput.computedAt), "PERCENT"),
    metric(deal, "maxPurchasePrice", "Maksymalna cena zakupu", result.maxPurchasePrice, provenance("underwriting.result.maxPurchasePrice", sourceOutput.inputFingerprint, "ESTIMATE", sourceOutput.computedAt), "PLN"),
    metric(deal, "totalProjectCost", "Łączny koszt projektu", result.totalProjectCost, provenance("underwriting.result.totalProjectCost", sourceOutput.inputFingerprint, "ESTIMATE", sourceOutput.computedAt), "PLN"),
  ] : [], missing, [...inheritedWarnings, ...sourceOutput.warnings], evidence, evidence.length ? evidence : [provenance("underwriting.validation", sourceOutput.inputFingerprint, null, sourceOutput.computedAt)], freshness, "Zysk, ROI, scenariusze, Max Buy i bramka pochodzą z istniejącego Investment OS.");
}

function riskLegal(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[], conflicts: BrainRisk[]): BrainDirector {
  const legalGate = deal.ceo.result?.criticalGates.find((gate) => gate.fact === "legalStatus");
  const legalEvidence = deal.evidenceFabric.some((item) => item.field === "legalStatus" && item.verificationStatus === "VERIFIED");
  const factConflicts = deal.verify.result?.conflicts ?? [];
  const missing = unique([...(legalGate && !legalGate.passed ? ["legalStatus"] : []), ...(deal.facts.ownership.effectiveValue == null ? ["ownership"] : [])]);
  const assignedRisks = conflicts.filter((item) => item.directorsInvolved.includes("RISK_LEGAL"));
  const blocker = assignedRisks.some((item) => item.severity === "BLOCKER");
  const status: BrainDirectorStatus = blocker ? "BLOCKED" : missing.length ? "NEEDS_DATA" : "READY";
  const evidence = [factProvenance("ownership", deal.facts.ownership), ...deal.evidenceFabric.filter((item) => ["legalStatus", "ownership"].includes(item.field ?? "")).map((item) => provenance(`evidenceFabric.${item.field}`, item.id, item.type, item.observedAt))].filter((item) => item.evidenceState !== "MISSING");
  const legalDescription = legalGate && !legalGate.passed
    ? legalEvidence ? "Istnieje oznaczony dowód, ale kanoniczna bramka nadal go nie akceptuje." : "Brak dowodu prawnego w zapisanym CanonicalDeal; nie jest to stwierdzenie wykrytej wady prawnej."
    : "Bramka prawna z kanonicznej analizy jest spełniona.";
  return output(deal, "RISK_LEGAL", status, blocker ? "Decyzję ogranicza brak lub konflikt dowodu" : "Ryzyka prawne i danych wymagają sprawdzenia", `${legalDescription}${factConflicts.length ? ` Wykryte konflikty: ${factConflicts.join(", ")}.` : ""}`, missing.length ? "Zdobądź wskazany dokument prawny lub potwierdź formę własności przed decyzją." : "Zachowaj dokumenty jako dowód dla warunków zakupu.", [
    metric(deal, "legalGate", "Bramka stanu prawnego", legalGate?.passed ?? null, provenance("ceo.result.criticalGates.legalStatus", deal.ceo.inputFingerprint, legalGate?.passed ? "FACT" : null, deal.ceo.computedAt)),
    metric(deal, "ownership", "Forma własności", deal.facts.ownership.effectiveValue, factProvenance("ownership", deal.facts.ownership)),
    metric(deal, "factConflictCount", "Konflikty materialne", factConflicts.length, provenance("verify.result.conflicts", deal.verify.inputFingerprint, "FACT", deal.verify.computedAt), "COUNT"),
  ], missing, [...inheritedWarnings, ...assignedRisks.map((risk) => risk.explanation)], evidence, [...evidence, ...assignedRisks.flatMap((risk) => risk.provenance)], freshness, "Nie stwierdzaj wady prawnej bez dowodu; pokaż dokładnie stan kanonicznej bramki i zapisanych dokumentów.");
}

function cfo(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const result = deal.underwriting.result;
  const missing = result ? ["financing"] : ["economics", "financing"];
  const status: BrainDirectorStatus = result ? "NEEDS_DATA" : "NEEDS_DATA";
  const evidence = provenanceEntries(deal.underwriting.provenance.filter((item) => ["totalProjectCost", "profit", "renovationPerM2"].includes(item.field)));
  return output(deal, "CFO", status, result ? "Interpretacja istniejącej ekonomiki" : "Brak kanonicznych liczb do interpretacji", result ? "Kapitał projektu, wynik i ROI są pokazane z kanonicznego underwritingu. CanonicalDeal nie ujawnia jawnej konfiguracji finansowania, więc brain nie dopisuje kredytu ani jego kosztu." : "Bez kanonicznego wyniku finansowego nie da się bezpiecznie opisać wymaganego kapitału.", result ? "Potwierdź źródło kapitału i warunki finansowania w istniejących danych transakcji." : "Najpierw przywróć kompletne, zwalidowane dane do kanonicznego underwritingu.", result ? [
    metric(deal, "capitalRequired", "Łączny koszt projektu", result.totalProjectCost, provenance("underwriting.result.totalProjectCost", deal.underwriting.inputFingerprint, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
    metric(deal, "profitBase", "Zysk bazowy", result.profitBase, provenance("underwriting.result.profitBase", deal.underwriting.inputFingerprint, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
    metric(deal, "roiBase", "Zwrot z inwestycji", result.roiBase, provenance("underwriting.result.roiBase", deal.underwriting.inputFingerprint, "ESTIMATE", deal.underwriting.computedAt), "PERCENT"),
    metric(deal, "financingCosts", "Koszt finansowania w wyniku", result.financingCosts, provenance("underwriting.result.financingCosts", deal.underwriting.inputFingerprint, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
  ] : [], missing, [...inheritedWarnings, "Brak jawnych danych o źródle kapitału i konfiguracji finansowania; nie przyjęto oprocentowania ani wkładu własnego."], evidence, evidence.length ? evidence : [provenance("underwriting.result", deal.underwriting.inputFingerprint, null, deal.underwriting.computedAt)], freshness, "Interpretacja używa wyłącznie liczb zwróconych przez kanoniczny silnik.");
}

function acquisition(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[], conflicts: BrainRisk[]): BrainDirector {
  const ceo = deal.ceo.result;
  const result = deal.underwriting.result;
  const manualVeto = deal.ceo.vetoes.some((veto) => veto.code === "HARD_REJECT_VETO") || ceo?.decision === "REJECT";
  const gates = ceo?.criticalGates ?? [];
  const openGates = gates.filter((gate) => !gate.passed);
  const riskBlocker = conflicts.some((item) => item.directorsInvolved.includes("ACQUISITION") && item.severity === "BLOCKER");
  const missing = unique([...openGates.map((gate) => gate.fact), ...(!result?.maxPurchasePrice ? ["maxPurchasePrice"] : [])]);
  const status: BrainDirectorStatus = manualVeto || riskBlocker ? "BLOCKED" : openGates.length || !result ? "NEEDS_DATA" : "READY";
  const action = manualVeto ? "REJECT" : ceo?.action === "KUP" && openGates.length === 0 && deal.ceo.validation.status === "PASS" ? "BUY" : ceo?.action === "NEGOCJUJ" ? "NEGOTIATE" : openGates.length ? "VERIFY" : "WAIT";
  const recommendation = action === "REJECT" ? "Zachowaj nadrzędną decyzję odrzucenia." : action === "NEGOTIATE" ? ceo?.nextBestAction ?? "Negocjuj wyłącznie w granicach kanonicznego limitu." : action === "BUY" ? "Warunki kanonicznej analizy są spełnione; zakup nadal wymaga decyzji człowieka." : action === "VERIFY" ? "Nie składaj wiążącej oferty przed zamknięciem otwartych bramek." : "Wstrzymaj działanie do czasu uzupełnienia danych krytycznych.";
  const evidence = [factProvenance("askingPrice", deal.facts.askingPrice), provenance("underwriting.result.maxPurchasePrice", deal.underwriting.inputFingerprint, "ESTIMATE", deal.underwriting.computedAt), provenance("ceo.result.criticalGates", deal.ceo.inputFingerprint, "FACT", deal.ceo.computedAt)].filter((item) => item.evidenceState !== "MISSING");
  return output(deal, "ACQUISITION", status, `Działanie warunkowe: ${action}`, `Kierunek wynika z kanonicznej decyzji CEO, Max Buy, bramek i nadrzędnej decyzji ręcznej. Otwarte bramki: ${openGates.length}.`, recommendation, [
    metric(deal, "acquisitionAction", "Działanie", action, provenance("ceo.result.action", deal.ceo.inputFingerprint, "FACT", deal.ceo.computedAt)),
    metric(deal, "askingPrice", "Cena ofertowa", deal.facts.askingPrice.effectiveValue, factProvenance("askingPrice", deal.facts.askingPrice), "PLN"),
    metric(deal, "maxPurchasePrice", "Maksymalna cena zakupu", result?.maxPurchasePrice ?? ceo?.maxPurchasePrice ?? null, provenance("underwriting.result.maxPurchasePrice", deal.underwriting.inputFingerprint, "ESTIMATE", deal.underwriting.computedAt), "PLN"),
    metric(deal, "openCriticalGates", "Otwarte bramki krytyczne", openGates.length, provenance("ceo.result.criticalGates", deal.ceo.inputFingerprint, "FACT", deal.ceo.computedAt), "COUNT"),
  ], missing, [...inheritedWarnings, ...openGates.map((gate) => gate.reason)], evidence, evidence, freshness, "Działanie pochodzi z kanonicznego CEO i Max Buy; nie dodano drugiego progu zakupu.");
}

function sale(deal: CanonicalDeal, freshness: BrainFreshness, inheritedWarnings: string[]): BrainDirector {
  const market = deal.market.result;
  const missing = market ? [] : ["marketEvidence"];
  const supported = Boolean(market && market.compCount > 0 && market.priceEvidenceType !== "USER_ASSUMPTION" && market.fallbackLevel === 0);
  const status: BrainDirectorStatus = !market ? "NEEDS_DATA" : supported ? "READY" : "NEEDS_DATA";
  const evidence = provenanceEntries(deal.market.provenance);
  return output(deal, "SALE", status, market ? "Przedział możliwej sprzedaży" : "Brak potwierdzonej wyceny wyjścia", market ? `Zakres z kanonicznego modułu rynku: ${market.resaleValueLow}–${market.resaleValueHigh} zł, wartość bazowa ${market.resaleValueBase} zł. System nie ma zapisanego dowodu czasu sprzedaży.` : "Nie ma użytecznego przedziału wyjścia; nie estymowano czasu sprzedaży.", supported ? "Sprawdź aktualność porównań przed przyjęciem ceny wyjścia." : "Uzupełnij wiarygodne porównania; nie traktuj założenia jako obserwacji rynku.", market ? [
    metric(deal, "resaleValueLow", "Wartość wyjścia — dół przedziału", market.resaleValueLow, provenance("market.result.resaleValueLow", market.evidenceId, "ESTIMATE", market.observedAt), "PLN"),
    metric(deal, "resaleValueBase", "Wartość wyjścia — baza", market.resaleValueBase, provenance("market.result.resaleValueBase", market.evidenceId, "ESTIMATE", market.observedAt), "PLN"),
    metric(deal, "resaleValueHigh", "Wartość wyjścia — góra przedziału", market.resaleValueHigh, provenance("market.result.resaleValueHigh", market.evidenceId, "ESTIMATE", market.observedAt), "PLN"),
    metric(deal, "comparableCount", "Liczba porównań", market.compCount, provenance("market.result.compCount", market.evidenceId, "FACT", market.observedAt), "COUNT"),
  ] : [], missing, [...inheritedWarnings, ...(market && !supported ? ["Jakość lub źródło wartości wyjścia wymaga dodatkowego potwierdzenia."] : [])], evidence, evidence.length ? evidence : [provenance("market.result", deal.market.inputFingerprint, null, deal.market.computedAt)], freshness, "Wartości sprzedaży pochodzą z istniejącego wyniku MARKET; czas sprzedaży nie jest zgadywany.");
}

export function createBrainDirector(deal: CanonicalDeal, id: "CEO", input: { status: BrainDirectorStatus; headline: string; summary: string; finding: string; recommendation: string; missingInputs: string[]; warnings: string[]; evidence: BrainProvenance[]; freshness: BrainFreshness; risks: BrainRisk[] }): BrainDirector {
  return output(deal, id, input.status, input.headline, input.summary, input.recommendation, [], input.missingInputs, input.warnings, input.evidence, input.evidence, input.freshness, input.finding, input.risks);
}

function output(deal: CanonicalDeal, id: BrainDirectorId, status: BrainDirectorStatus, headline: string, summary: string, recommendation: string, metrics: BrainMetric[], missingInputs: string[], warnings: string[], evidence: BrainProvenance[], provenanceEntriesValue: BrainProvenance[], freshness: BrainFreshness, finding: string, risks: BrainRisk[] = []): BrainDirector {
  const sourceOutput = sourceFor(deal, id);
  const sourceFingerprint = sourceOutput?.inputFingerprint ?? null;
  const uniqueEvidence = uniqueProvenance(evidence);
  const missing = [...new Set(missingInputs)];
  const questions = missing.filter((field) => ["legalStatus", "ownership", "askingPrice", "areaM2", "city", "marketEvidence", "renovationScope", "identity", "riskReview", "condition", "financing"].includes(field));
  return {
    id, status, headline, summary, finding, recommendation, metrics, confidenceState: confidenceState(uniqueEvidence, missing, freshness),
    evidence: uniqueEvidence, dependencies: dependenciesFor(id), missingInputs: missing, warnings: [...new Set(warnings.filter(Boolean))], questionFields: questions,
    provenance: uniqueProvenance(provenanceEntriesValue), freshness,
    generatedFrom: { dealId: deal.id, factsFingerprint: deal.factsFingerprint, outputFingerprint: sourceFingerprint, sourceUpdatedAt: deal.updatedAt }, risks,
  };
}

function sourceFor(deal: CanonicalDeal, id: BrainDirectorId): DirectorOutput<unknown> | null {
  const key = SOURCE_OUTPUTS[id];
  if (!key) return null;
  return deal[key] as DirectorOutput<unknown>;
}

function factProvenance(field: keyof DealFacts, fact: FactValue<unknown>): BrainProvenance {
  return { sourcePath: `facts.${field}`, sourceId: fact.evidenceId ?? fact.source, classification: fact.classification ?? null, evidenceState: fact.effectiveValue == null ? "MISSING" : isAssumption(fact.classification) ? "ASSUMPTION" : "PRESENT", observedAt: fact.observedAt };
}

function provenanceEntries(entries: ProvenanceEntry[]): BrainProvenance[] {
  return entries.map((item) => ({ sourcePath: item.field, sourceId: item.evidenceId ?? item.assumptionId ?? item.sourceId ?? null, classification: item.classification ?? null, evidenceState: isAssumption(item.classification) || ["USER_ASSUMPTION", "MARKET_ASSUMPTION", "MANUAL_OVERRIDE"].includes(item.provenance) ? "ASSUMPTION" : item.evidenceId || item.sourceId || item.assumptionId ? "PRESENT" : "MISSING", observedAt: item.observedAt ?? null }));
}

function provenance(sourcePath: string, sourceId: string | null, classification: BrainProvenance["classification"], observedAt: string | null): BrainProvenance {
  return { sourcePath, sourceId, classification, evidenceState: classification === "ASSUMPTION" || classification === "ESTIMATE" || classification === "USER_OVERRIDE" ? "ASSUMPTION" : sourceId ? "PRESENT" : "MISSING", observedAt };
}

function metric(deal: CanonicalDeal, key: string, metricLabel: string, value: BrainMetric["value"], source: BrainProvenance, unit?: BrainMetric["unit"]): BrainMetric {
  return { key, label: metricLabel, value, unit, provenance: source };
}

function combineProvenance(entries: BrainProvenance[]): BrainProvenance {
  return { sourcePath: entries.map((item) => item.sourcePath).join(" + "), sourceId: entries.map((item) => item.sourceId).filter(Boolean).join(", ") || null, classification: entries.every((item) => item.classification === "FACT") ? "FACT" : "UNKNOWN", evidenceState: entries.every((item) => item.evidenceState !== "MISSING") ? "PRESENT" : "MISSING", observedAt: entries.map((item) => item.observedAt).find(Boolean) ?? null };
}

function confidenceState(evidence: BrainProvenance[], missing: string[], freshness: BrainFreshness): BrainConfidenceState {
  if (freshness === "STALE" || (!evidence.length && missing.length)) return "UNKNOWN";
  if (missing.length) return "LIMITED_EVIDENCE";
  if (!evidence.length) return "UNKNOWN";
  if (evidence.some((item) => item.evidenceState === "ASSUMPTION" || item.classification === "ESTIMATE" || item.classification === "ASSUMPTION" || item.classification === "USER_OVERRIDE")) return "EVIDENCE_WITH_ASSUMPTIONS";
  if (evidence.some((item) => item.evidenceState === "MISSING")) return "LIMITED_EVIDENCE";
  return "STRONG_EVIDENCE";
}

function directFreshnessFor(deal: CanonicalDeal): Record<Exclude<BrainDirectorId, "CEO">, BrainFreshness> {
  const hasStaleFact = (fields: (keyof DealFacts)[]) => fields.some((field) => deal.facts[field].effectiveValue != null && deal.facts[field].freshness === "STALE");
  const outputStale = (...statuses: string[]) => statuses.includes("STALE");
  const marketStale = deal.market.validation.checks.some((check) => check.code === "MARKET_EVIDENCE_FRESH" && !check.passed);
  const timestampsKnown = [deal.createdAt, deal.updatedAt, deal.scout.computedAt].every(isTimestamp);
  return {
    SCOUT: hasStaleFact(["source", "sourceUrl", "postId", "askingPrice", "areaM2", "rooms", "city", "district", "street", "buildingType", "imageCount"]) || outputStale(deal.scout.status) ? "STALE" : timestampsKnown ? "CURRENT" : "UNKNOWN",
    VERIFY: hasStaleFact(["source", "sourceUrl", "postId", "askingPrice", "areaM2", "rooms", "city", "district", "street", "buildingType", "ownership", "condition"]) || outputStale(deal.verify.status) ? "STALE" : isTimestamp(deal.verify.computedAt) ? "CURRENT" : "UNKNOWN",
    MARKET: marketStale || outputStale(deal.market.status) ? "STALE" : isTimestamp(deal.market.result?.observedAt ?? null) ? "CURRENT" : "UNKNOWN",
    RENOVATION: hasStaleFact(["areaM2", "condition", "buildingType"]) || outputStale(deal.underwriting.status) ? "STALE" : isTimestamp(deal.underwriting.computedAt) ? "CURRENT" : "UNKNOWN",
    UNDERWRITER: hasStaleFact(["askingPrice", "areaM2", "rooms", "condition"]) || outputStale(deal.underwriting.status) ? "STALE" : isTimestamp(deal.underwriting.computedAt) ? "CURRENT" : "UNKNOWN",
    RISK_LEGAL: hasStaleFact(["ownership", "buildingType", "condition", "sourceUrl", "postId"]) || outputStale(deal.verify.status, deal.ceo.status) ? "STALE" : isTimestamp(deal.ceo.computedAt) ? "CURRENT" : "UNKNOWN",
    CFO: outputStale(deal.underwriting.status) ? "STALE" : isTimestamp(deal.underwriting.computedAt) ? "CURRENT" : "UNKNOWN",
    ACQUISITION: outputStale(deal.underwriting.status, deal.ceo.status) ? "STALE" : isTimestamp(deal.ceo.computedAt) ? "CURRENT" : "UNKNOWN",
    SALE: marketStale || outputStale(deal.market.status) ? "STALE" : isTimestamp(deal.market.result?.observedAt ?? null) ? "CURRENT" : "UNKNOWN",
  };
}

function propagateFreshness(own: BrainFreshness, upstream: BrainFreshness[]): BrainFreshness {
  if (own === "STALE" || upstream.includes("STALE")) return "STALE";
  if (own === "UNKNOWN" || upstream.includes("UNKNOWN")) return "UNKNOWN";
  return "CURRENT";
}

function isTimestamp(value: string | null): boolean { return Boolean(value && Number.isFinite(Date.parse(value))); }
function isAssumption(value: unknown): boolean { return value === "ASSUMPTION" || value === "ESTIMATE" || value === "USER_OVERRIDE"; }
function label(field: string): string { return FIELD_LABELS[field] ?? field; }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function uniqueProvenance(values: BrainProvenance[]): BrainProvenance[] { return [...new Map(values.map((item) => [`${item.sourcePath}:${item.sourceId ?? "missing"}`, item])).values()]; }
