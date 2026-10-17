import test from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalDeal } from "./engine";
import { lodzDeal } from "./test-fixtures/lodz-deals";
import { ceoRecommendation } from "./ceo-recommendation";
import { roomQuestions } from "./deal-room-answers";
function fixture(){return buildCanonicalDeal({...lodzDeal(),features:{cfo:false,taxReview:false,taxArithmetic:false,privateTax:false,jdgTax:false}});}
test("CEO is a canonical read: exact amounts incl cents, all three scenarios, no independent arithmetic or tax net",()=>{
 const d=fixture(),u=d.underwriting.result!;u.maxPurchasePrice=123456.78;u.profitLow=11001.11;u.profitBase=22002.22;u.profitHigh=33003.33;
 d.ceo.result!.maxPurchasePrice=999999;const m=ceoRecommendation(d);
 assert.equal(m.maxBuy,123456.78);assert.deepEqual(m.profits,{conservative:11001.11,base:22002.22,optimistic:33003.33});assert.ok(m.risks.length<=5);assert.equal(m.humanApprovalRequired,true);
 for(const c of m.conditions){assert.ok(c.what&&c.why&&c.evidence&&c.directors.length);if(c.questionField)assert.ok(roomQuestions(d,{version:0,answers:{},baselineOverrides:{},rounds:[]}).some(q=>q.field===c.questionField));}
 assert.equal(m.conditions.find(c=>c.field==="legalStatus")?.state,"UNKNOWN");
});
test("HOLD / NEGOTIATE / BUY / REJECT use the existing synthesis, not the profit sign",()=>{
 const hold=fixture();hold.ceo.result!.action="HOLD / ZBIERZ DANE";hold.ceo.result!.decision="REVIEW";assert.equal(ceoRecommendation(hold).decision,"HOLD");
 const negotiate=fixture();negotiate.ceo.result!.action="NEGOCJUJ";negotiate.ceo.result!.decision="TOO_EXPENSIVE";negotiate.ceo.result!.openingOffer=100000.12;
 assert.equal(ceoRecommendation(negotiate).decision,"NEGOCJUJ");assert.equal(ceoRecommendation(negotiate).negotiation,100000.12);
 const buy=buildCanonicalDeal({...lodzDeal(),listing:{...lodzDeal().listing,askingPrice:100000},features:{cfo:false,taxReview:false,taxArithmetic:false,privateTax:false,jdgTax:false}});buy.ceo.result!.action="KUP";buy.ceo.result!.decision="HOT";buy.ceo.result!.criticalGates.forEach(g=>g.passed=true);buy.ceo.status="COMPLETE";buy.ceo.validation.status="PASS";buy.verify.status="COMPLETE";buy.verify.validation.status="PASS";buy.market.status="COMPLETE";buy.market.validation.status="PASS";buy.underwriting.validation.status="PASS";
 assert.equal(ceoRecommendation(buy).decision,"KUP","only a fully validated canonical BUY fixture may display BUY");
 const missing=structuredClone(buy);missing.ceo.result!.criticalGates.find(g=>g.fact==="legalStatus")!.passed=false;assert.notEqual(ceoRecommendation(missing).decision,"KUP");
 const empty=structuredClone(buy);empty.ceo.result!.criticalGates=[];assert.notEqual(ceoRecommendation(empty).decision,"KUP");
 const fail=structuredClone(buy);fail.underwriting.validation.status="FAIL";assert.notEqual(ceoRecommendation(fail).decision,"KUP");
 const failedMarket=structuredClone(buy);failedMarket.market.validation.status="FAIL";assert.notEqual(ceoRecommendation(failedMarket).decision,"KUP");
 const rejected=buildCanonicalDeal({...lodzDeal(),listing:{...lodzDeal().listing,manualDecision:"REJECTED"}});assert.equal(ceoRecommendation(rejected).decision,"ODRZUĆ");assert.equal(ceoRecommendation(rejected).blockers[0].state,"UNSATISFIED");
});
test("missing/corrupt finance cannot resurrect stale CEO amounts or fabricate zero/negotiation",()=>{
 const d=fixture();d.underwriting.result=null;d.ceo.result!.maxPurchasePrice=999999;const m=ceoRecommendation(d);assert.equal(m.maxBuy,null);assert.equal(m.negotiation,null);assert.deepEqual(m.profits,{conservative:null,base:null,optimistic:null});
 const other=fixture();other.underwriting.result!.maxPurchasePrice=NaN;other.underwriting.result!.profitHigh=Infinity;assert.equal(ceoRecommendation(other).maxBuy,null);assert.equal(ceoRecommendation(other).profits.optimistic,null);
});
