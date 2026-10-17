import type { CanonicalDeal } from "./types";
import { buildDealBrain, type BrainDirectorId, type BrainQuestion } from "./brain";
import { CFO_LABELS } from "./cfo";

export type ConditionState="SATISFIED"|"UNSATISFIED"|"UNKNOWN";
export type CeoCondition={id:string;field:string;what:string;why:string;directors:BrainDirectorId[];evidence:string;state:ConditionState;questionField:string|null};
const META:Record<string,{what:string;why:string;evidence:string;directors:BrainDirectorId[]}>= {
 legalStatus:{what:"Zweryfikuj stan prawny lokalu",why:"Brak dokumentu nie potwierdza braku obciążeń ani możliwości bezpiecznej transakcji.",evidence:"Aktualna księga wieczysta i dokumenty ocenione przez uprawnioną osobę.",directors:["RISK_LEGAL","VERIFY"]},
 ownership:{what:"Potwierdź własność i umocowanie sprzedającego",why:"Sprzedający musi być uprawniony do zbycia wskazanego lokalu.",evidence:"Dokument własności i potwierdzenie umocowania do sprzedaży.",directors:["RISK_LEGAL","VERIFY"]},
 identity:{what:"Potwierdź tożsamość oferty i lokalu",why:"Analizy muszą dotyczyć tego samego mieszkania i źródła.",evidence:"Zgodne dane źródłowe i identyfikacja lokalu.",directors:["SCOUT","VERIFY"]},
 marketEvidence:{what:"Potwierdź cenę wyjścia porównaniami",why:"Orientacyjna wycena lub nieporównywalne dane nie otwierają bramki zakupu.",evidence:"Aktualne, niezależne porównania o zgodnej lokalizacji, metrażu i standardzie.",directors:["MARKET","SALE"]},
 renovationScope:{what:"Potwierdź zakres i budżet remontu",why:"Pominięte prace mogą zmienić koszty, termin i marżę.",evidence:"Oględziny, zakres robót i zweryfikowany kosztorys brutto.",directors:["RENOVATION","UNDERWRITER"]},
 economics:{what:"Zwaliduj pełną ekonomikę projektu",why:"Kwoty muszą pochodzić z kompletnego kanonicznego underwritingu.",evidence:"Potwierdzone dane wejściowe i poprawna walidacja analizy.",directors:["UNDERWRITER","CFO"]},
 riskReview:{what:"Rozstrzygnij istotne konflikty i ryzyka",why:"Dodatni zysk nie usuwa sprzecznych danych ani blokad prawnych.",evidence:"Rozstrzygnięcie konfliktu w dokumentach lub przegląd specjalisty.",directors:["VERIFY","RISK_LEGAL"]},
 financing:{what:"Potwierdź kapitał, finansowanie i podatki",why:"Dodatnia marża nie zapewnia gotówki na zakup i remont ani zysku po podatku.",evidence:"Harmonogram finansowania, rezerwa, warunki kredytu/inwestora i kwalifikacja podatkowa.",directors:["CFO","UNDERWRITER"]},
 askingPrice:{what:"Potwierdź aktualną cenę ofertową",why:"Aktualna cena źródłowa jest potrzebna do wiarygodnej oceny negocjacji.",evidence:"Aktualna, udokumentowana cena uzgodniona ze sprzedającym.",directors:["ACQUISITION","UNDERWRITER"]},
};
const known=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)?value:null;
/** Read projection only: no calculator, model, persistence, tax mutation or independent decision. */
export function ceoRecommendation(deal:CanonicalDeal){
 const brain=buildDealBrain(deal),u=deal.underwriting.result,cfo=u?.cfo;
 const valid=deal.underwriting.validation.status==="PASS"&&u!==null;
 const maxBuy=valid?known(cfo?cfo.selected?.maxBuy:u?.maxPurchasePrice):null;
 const decision=({BUY:"KUP",NEGOTIATE:"NEGOCJUJ",VERIFY:"HOLD",WAIT:"HOLD",REJECT:"ODRZUĆ"} as const)[brain.ceo.decision];
 const opening=known(deal.ceo.result?.openingOffer);
 const negotiation=decision==="NEGOCJUJ"&&valid&&maxBuy!==null&&opening!==null&&opening>0&&opening<=maxBuy?opening:null;
 const pending=[...brain.questions];
 for(const field of cfo?.missing??[])if(CFO_LABELS[field]&&!pending.some(q=>q.field===field))pending.push({id:`cfo:${field}`,field,question:CFO_LABELS[field],whyItMatters:META.financing.why,evidenceNeeded:META.financing.evidence,requestingDirectors:["CFO","UNDERWRITER"],category:"BLOCKING",priority:"CRITICAL",affectedDecision:["HOLD","BUY"],affectedMetrics:["Płynność"],valueOfInformation:null});
 const conditions:CeoCondition[]=(deal.ceo.result?.criticalGates??[]).map(gate=>{
  const fallback=META[gate.fact]??{what:`Potwierdź: ${gate.fact}`,why:gate.reason,evidence:"Potwierdzony dokument lub informacja wymagana przez dyrektora.",directors:["VERIFY","CEO"] as BrainDirectorId[]};
  const question=pending.find(q=>q.field===gate.fact)??(gate.fact==="financing"?pending.find(q=>(cfo?.missing??[]).includes(q.field)):undefined);
  let state:ConditionState=gate.passed?"SATISFIED":"UNKNOWN";
  if(!gate.passed&&((gate.fact==="riskReview"&&(deal.verify.result?.conflicts.length??0)>0)||(gate.fact==="financing"&&(cfo?.selected?.fundingGap??0)>0)||(gate.fact==="askingPrice"&&maxBuy!==null&&(deal.facts.askingPrice.effectiveValue??0)>maxBuy)))state="UNSATISFIED";
  return {id:`gate:${gate.fact}`,field:gate.fact,what:question?.question??fallback.what,why:question?.whyItMatters??fallback.why,directors:question?.requestingDirectors??fallback.directors,evidence:question?.evidenceNeeded??fallback.evidence,state,questionField:question?.field??null};
 });
 const price=valid?known(u?.purchasePrice):null;
 conditions.push({id:"canonical-price-limit",field:"purchasePriceLimit",what:"Cena zakupu przyjęta w analizie nie przekracza kanonicznego Max Buy",why:"To kryterium liczbowe, nie weryfikacja uzgodnień ze sprzedającym. Zadeklarowana cena pozostaje założeniem, dopóki nie ma potwierdzenia.",directors:["ACQUISITION","UNDERWRITER","CFO"],evidence:"Udokumentowana cena uzgodniona ze sprzedającym; ponowna walidacja istniejącego underwritingu.",state:price===null||maxBuy===null?"UNKNOWN":price<=maxBuy?"SATISFIED":"UNSATISFIED",questionField:"negotiatedPrice"});
 for(const q of pending.filter(q=>q.category==="BLOCKING"))if(!conditions.some(c=>c.questionField===q.field||c.field===q.field))conditions.push(questionCondition(q));
 if(decision==="ODRZUĆ")conditions.unshift({id:"hard-reject",field:"rejection",what:"Zachowaj odrzucenie oferty",why:"Twarde lub ręczne odrzucenie pozostaje nadrzędne; scoring i odpowiedź nie mogą go automatycznie cofnąć.",directors:["VERIFY","RISK_LEGAL","CEO"],evidence:"Odrębna, udokumentowana decyzja człowieka — bez automatycznej reaktywacji.",state:"UNSATISFIED",questionField:null});
 const rank={BLOCKER:0,MATERIAL:1,WATCH:2,INFO:3};
 const risks=[...new Map([...brain.conflicts,...Object.values(brain.directors).flatMap(d=>d.risks)].map(r=>[r.id,r])).values()].sort((a,b)=>rank[a.severity]-rank[b.severity]).slice(0,5);
 return {decision,maxBuy,negotiation,profits:{conservative:valid?known(u?.profitLow):null,base:valid?known(u?.profitBase):null,optimistic:valid?known(u?.profitHigh):null},beforeFinancing:Boolean(cfo),conditions,blockers:conditions.filter(c=>c.state!=="SATISFIED"),risks,next:brain.ceo.nextBestAction,reason:brain.ceo.reasoningSummary,humanApprovalRequired:true as const};
}
function questionCondition(q:BrainQuestion):CeoCondition{return {id:`question:${q.field}`,field:q.field,what:q.question,why:q.whyItMatters,directors:q.requestingDirectors,evidence:q.evidenceNeeded,state:"UNKNOWN",questionField:q.field};}
