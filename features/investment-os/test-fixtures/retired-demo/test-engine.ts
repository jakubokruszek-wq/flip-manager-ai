import { lodzDeal } from "./synthetic-deals";
import { buildCanonicalDeal } from "../../engine";
import { TEST_DEAL_FEATURES } from "./test-features";
import { markIndicative } from "../../market-fallback";
import { testCases } from "./test-mode";
import type { DealFactOverrides } from "../../types";
/** Virtual listing + comparables ONLY. No real data resolver, settings, Radar, source or network calls. */
export function buildTestDeal(actorId:string,id:string,overrides:DealFactOverrides={},now="2026-10-15T12:00:00.000Z") {
 const item=testCases(actorId).find(c=>c.id===id);if(!item)throw Error("TEST_NOT_FOUND");
 const base=lodzDeal("UNCLEAR_RENOVATION");
 const deal=buildCanonicalDeal({...base,features:TEST_DEAL_FEATURES,dealId:id,now,listing:{...base.listing,id,sourceUrl:`https://example.test/deal-room/${id}`,externalListingId:id,street:item.title,askingPrice:item.price,identityExact:false,imageCount:0,manualDecision:item.key==="reject"?"REJECTED":null},market:base.market?markIndicative(base.market,"syntetyczne porównania TEST — brak rzeczywistego Radaru",null):null,overrides});
 // TEST can demonstrate rejection, never authorize a transaction, even after all answers.
 if(deal.ceo.result){
  const reject=deal.ceo.result.action==="ODRZUĆ";
  deal.ceo.result={...deal.ceo.result,action:reject?"ODRZUĆ":"HOLD / ZBIERZ DANE",decision:reject?"REJECT":"REVIEW",openingOffer:null,targetPurchasePrice:null,headline:reject?"TEST · zachowaj odrzucenie":"TEST · analiza syntetyczna, bez zakupu",recommendation:"Wyłącznie test pytań i przeliczeń. Nie składaj oferty ani nie kupuj na tej podstawie.",nextBestAction:"Kontynuuj wyłącznie test na danych syntetycznych.",risks:[...deal.ceo.result.risks,"TEST_ONLY_NO_PURCHASE"],criticalGates:[...deal.ceo.result.criticalGates,{fact:"testOnly",passed:false,reason:"Wirtualny scenariusz TEST nigdy nie uprawnia do zakupu."}]};
 }
 return deal;
}
