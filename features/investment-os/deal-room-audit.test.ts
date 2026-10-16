import test from "node:test";
import assert from "node:assert/strict";
import {buildCanonicalDeal} from "./engine";
import {buildDealBrain,BRAIN_DIRECTORS} from "./brain/index";
import {lodzDeal} from "./test-fixtures/lodz-deals";
import {parseAnswerCommand,mergeAnswers,answerOverrides,affectedDirectors} from "./deal-room-answers";
import {markIndicative,usableRadar} from "./market-fallback";
import {JDG_ENUMS} from "./jdg-tax";

test("three Łódź deals retain all directors, distinguish high/small margins and enforce reject before score",()=>{
 const keys=["DEAL_ROOM_CFO_ENABLED","DEAL_ROOM_TAX_REVIEW_ENABLED","DEAL_ROOM_JDG_TAX_ENABLED"] as const,old=keys.map(k=>process.env[k]);
 try{keys.forEach(k=>process.env[k]="true");const profits:number[]=[];
 for(const [i,price] of [200000,340000,680000].entries()){
  const b=lodzDeal(i===2?"EXPENSIVE_AREA_CONFLICT":"UNCLEAR_RENOVATION");const input={...b,listing:{...b.listing,id:`synthetic-lodz-${i}`,askingPrice:price,manualDecision:i===2?"REJECTED" as const:null},overrides:{costScope:"BRUTTO",financingMode:"CASH",equity:800000,liquidityReserve:30000,deposit:20000,renovationMonths:3,equipment:0,holdingMonths:6,renovationTotal:40000,taxScenario:"JDG",taxAcquiredOn:"2026-04-01",taxSaleOn:"2026-10-01"}};
  const first=buildCanonicalDeal(input),brain=buildDealBrain(first);for(const director of BRAIN_DIRECTORS)assert.ok(brain.directors[director]);
  if(i===2){assert.equal(first.ceo.result?.action,"ODRZUĆ");assert.equal(brain.ceo.decision,"REJECT");continue;}
  const profit=first.underwriting.result?.cfo?.selected?.projectProfitBeforeTax;assert.equal(typeof profit,"number");profits.push(profit!);assert.equal(first.underwriting.result?.cfo?.jdgTax?.status,"UNKNOWN");assert.notEqual(first.ceo.result?.action,"KUP");
  const state={version:1,answers:{},baselineOverrides:input.overrides,rounds:[]};const command=parseAnswerCommand({requestId:crypto.randomUUID(),expectedVersion:1,answers:[{field:"renovationBudget",kind:"VALUE",value:100000,basis:"ASSUMPTION",evidenceUrl:null},{field:"jdgForm",kind:"VALUE",value:JDG_ENUMS.jdgForm,basis:"ASSUMPTION",evidenceUrl:null}]});
  const answers=mergeAnswers(first,state,command,"synthetic-owner",input.now);const next=buildCanonicalDeal({...input,overrides:answerOverrides(first,input.overrides,answers)});
  assert.ok(next.underwriting.result!.cfo!.selected!.projectProfitBeforeTax!<profit!);assert.notEqual(next.underwriting.inputFingerprint,first.underwriting.inputFingerprint);assert.notEqual(next.ceo.inputFingerprint,first.ceo.inputFingerprint);assert.equal(next.market.inputFingerprint,first.market.inputFingerprint);assert.equal(next.underwriting.result?.cfo?.jdgTax?.pit,null);
  for(const d of ["RENOVATION","UNDERWRITER","CFO","CEO"] as const)assert.ok(affectedDirectors(["renovationBudget"]).includes(d));
 }
 assert.ok(profits[0]>100000);assert.ok(profits[1]>0&&profits[1]<50000);assert.ok(profits[0]>profits[1]+75000);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
test("insufficient Radar uses existing indicative general fallback, never a fabricated confident valuation",()=>{
 const b=lodzDeal();assert.ok(b.market);assert.equal(usableRadar({...b.market!,compCount:0,minimumSample:10},b.now),false);
 const fallback=markIndicative(b.market!,"ogólne porównania syntetyczne",null);const deal=buildCanonicalDeal({...b,market:fallback});
 assert.equal(deal.market.result?.indicative,true);assert.ok(deal.market.confidence<=60);assert.notEqual(deal.ceo.result?.action,"KUP");
 const absent=buildCanonicalDeal({...b,market:null});assert.notEqual(absent.ceo.result?.action,"KUP");
});
