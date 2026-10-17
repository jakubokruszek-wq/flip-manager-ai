import test from "node:test";
import assert from "node:assert/strict";
import { buildTestDeal } from "./test-fixtures/retired-demo/test-engine";
import { testCases } from "./test-fixtures/retired-demo/test-mode";
import { buildDealBrain,BRAIN_DIRECTORS } from "./brain";
import { buildCanonicalDeal } from "./engine";
import { lodzDeal } from "./test-fixtures/retired-demo/synthetic-deals";
import { dealFeatures } from "./feature-context";
import { TEST_DEAL_FEATURES } from "./test-fixtures/retired-demo/test-features";
import { parseAnswerCommand,mergeAnswers,answerOverrides } from "./deal-room-answers";
const owner="33333333-3333-4333-8333-333333333333";
test("virtual cases reuse all ten directors, synthetic indicative fallback, CFO/tax Q&A without activating real flags or BUY",()=>{
 const before={...process.env},profits:number[]=[];
 for(const c of testCases(owner)){
  const deal=buildTestDeal(owner,c.id,{costScope:"BRUTTO",financingMode:"CASH",equity:800000,liquidityReserve:30000,deposit:20000,renovationMonths:3,equipment:0,holdingMonths:6,renovationTotal:40000,taxScenario:"JDG"});
  const brain=buildDealBrain(deal);for(const d of BRAIN_DIRECTORS)assert.ok(brain.directors[d]);
  assert.equal(deal.market.result?.indicative,true);assert.notEqual(deal.ceo.result?.action,"KUP");assert.notEqual(brain.ceo.decision,"BUY");assert.equal(deal.ceo.result?.openingOffer,null);assert.ok(deal.ceo.result?.criticalGates.some(g=>g.fact==="testOnly"&&!g.passed));
  assert.equal(deal.underwriting.result?.cfo?.taxStatus,"UNKNOWN");assert.equal(deal.underwriting.result?.cfo?.netProfit,null);
  if(c.key==="reject")assert.equal(deal.ceo.result?.action,"ODRZUĆ");else profits.push(deal.underwriting.result!.cfo!.selected!.projectProfitBeforeTax!);
  const state={answers:{},baselineOverrides:{},rounds:[],version:1};
  const command=parseAnswerCommand({requestId:crypto.randomUUID(),expectedVersion:1,answers:[{field:"renovationBudget",kind:"VALUE",value:100000,basis:"ASSUMPTION",evidenceUrl:null}]},TEST_DEAL_FEATURES);
  const answers=mergeAnswers(deal,state,command,owner,deal.updatedAt,TEST_DEAL_FEATURES);
  const next=buildTestDeal(owner,c.id,answerOverrides(deal,{},answers));assert.equal(next.underwriting.result?.renovationTotal,100000);
 }
 assert.ok(profits[0]>profits[1]);assert.deepEqual({...process.env},before);
 const flags=dealFeatures(),real=buildCanonicalDeal(lodzDeal());assert.equal(Boolean(real.underwriting.result?.cfo),flags.cfo);
});
