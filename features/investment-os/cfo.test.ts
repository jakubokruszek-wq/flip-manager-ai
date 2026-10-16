import test from "node:test";
import assert from "node:assert/strict";
import { analyseCfo, type CfoInputs } from "./cfo";
import { DEFAULT_UNDERWRITING_SETTINGS, calculateUnderwriting, type UnderwritingInput } from "../flip-finder/underwriting";
import { lodzDeal } from "./test-fixtures/lodz-deals";
import { buildCanonicalDeal } from "./engine";
import { parseAnswerCommand,mergeAnswers,answerOverrides,affectedDirectors } from "./deal-room-answers";
const input={listingId:"1",source:"facebook",sourceUrl:"https://example.test/1",areaM2:45,rooms:2,askingPrice:300000,priceOverride:260000,renovationTotalOverride:100000,holdingMonthsOverride:6,resalePerM2:{low:9000,base:10000,high:11000,provenance:"MARKET_ASSUMPTION",confidence:80},condition:"do remontu"} as UnderwritingInput;
const params:CfoInputs={costScope:"BRUTTO",financingMode:"CASH",equity:500000,liquidityReserve:30000,deposit:26000,renovationMonths:3,equipment:0,loanAmount:200000,loanRate:12,loanFee:2000,loanTermMonths:120,loanSchedule:"INTEREST_ONLY",loanSecurity:"Deklarowana hipoteka, oferta do sprawdzenia",investorCapital:200000,investorProfitShare:50,investorLossShare:50};
test("same operating base, cash equals existing calculator; loan fees/interest and investor capital are not double costs",()=>{
 const c=analyseCfo(input,DEFAULT_UNDERWRITING_SETTINGS,params), u=calculateUnderwriting(input,{...DEFAULT_UNDERWRITING_SETTINGS,financingEnabled:false});
 assert.equal(c.variants[0].projectProfitBeforeTax,u.profitBase);assert.equal(c.variants[1].financingCost,14000);assert.equal(c.variants[1].projectProfitBeforeTax,Math.round((u.profitBase!-14000)*100)/100);
 assert.equal(c.variants[2].projectProfitBeforeTax,c.variants[0].projectProfitBeforeTax);assert.equal(c.variants[2].ownProfitBeforeTax,Math.round((c.variants[2].projectProfitBeforeTax!-Math.round(c.variants[2].projectProfitBeforeTax!*50)/100)*100)/100);
 for(const v of c.variants){assert.equal(v.status,"MODELLED");assert.ok(Math.abs(v.months.at(-1)!.balance-(params.equity!+v.ownProfitBeforeTax!))<.02);}
 assert.equal(c.taxStatus,"UNKNOWN");assert.equal(c.netProfit,null);
});
test("reserve is liquidity not expense, and deposit is part of purchase; shortfalls before loan draw remain visible",()=>{const a=analyseCfo(input,DEFAULT_UNDERWRITING_SETTINGS,params);const b=analyseCfo(input,DEFAULT_UNDERWRITING_SETTINGS,{...params,equity:0,liquidityReserve:60000,financingMode:"LOAN"});assert.equal(a.variants[0].projectProfitBeforeTax,b.variants[0].projectProfitBeforeTax);assert.ok(b.selected!.fundingGap!>=60000);assert.equal(b.selected!.months[0].balance,-26000);});
test("missing banking parameters are UNKNOWN; combined stress lowers profit and Max Buy, increases capital",()=>{const missing=analyseCfo(input,DEFAULT_UNDERWRITING_SETTINGS,{financingMode:"LOAN"});assert.equal(missing.selected?.status,"UNKNOWN");assert.equal(missing.selected?.financingCost,null);const c=analyseCfo(input,DEFAULT_UNDERWRITING_SETTINGS,params);const stress=c.stress.at(-1)!.result;assert.ok(stress.projectProfitBeforeTax!<c.selected!.projectProfitBeforeTax!);assert.ok(stress.peakOwnCapital!>c.selected!.peakOwnCapital!);assert.ok(stress.maxBuy!<c.selected!.maxBuy!);});
test("CFO typed Q&A invalidates dependent analyses; flag off preserves legacy behavior and rejects new fields",()=>{const old=process.env.DEAL_ROOM_CFO_ENABLED;try{process.env.DEAL_ROOM_CFO_ENABLED="true";const base=lodzDeal();const first=buildCanonicalDeal(base);assert.ok(first.underwriting.result?.cfo);assert.notEqual(first.ceo.result?.action,"KUP");const command=parseAnswerCommand({requestId:crypto.randomUUID(),expectedVersion:1,answers:Object.entries(params).map(([field,value])=>({field,value,kind:"VALUE",basis:"DECLARATION",evidenceUrl:null}))});const state={version:1,answers:{},baselineOverrides:{},rounds:[]};const answers=mergeAnswers(first,state,command,"operator",base.now);const next=buildCanonicalDeal({...base,overrides:answerOverrides(first,{},answers)});assert.equal(next.underwriting.result?.cfo?.selected?.mode,"CASH");assert.notEqual(first.ceo.inputFingerprint,next.ceo.inputFingerprint);assert.ok(affectedDirectors(["equity"]).includes("CEO"));process.env.DEAL_ROOM_CFO_ENABLED="false";assert.equal(buildCanonicalDeal(base).underwriting.result?.cfo,undefined);assert.throws(()=>parseAnswerCommand(command),/wyłączony/);}finally{if(old===undefined)delete process.env.DEAL_ROOM_CFO_ENABLED;else process.env.DEAL_ROOM_CFO_ENABLED=old;}});
test("annuity principal, investor split and final equity conserve cents; finance Max Buy is not an unsupported ceiling",()=>{const c=analyseCfo(input,DEFAULT_UNDERWRITING_SETTINGS,{...params,financingMode:"LOAN",loanSchedule:"ANNUITY",loanRate:0,loanAmount:100000,loanTermMonths:12,investorProfitShare:33.33});const loan=c.selected!;assert.equal(loan.financingCost,2000);assert.ok(Math.abs(loan.months.at(-1)!.balance-(params.equity!+loan.ownProfitBeforeTax!))<.02);for(const v of c.variants) assert.ok(Math.abs(v.months.at(-1)!.balance-(params.equity!+v.ownProfitBeforeTax!))<.02);if(loan.maxBuy!==null){const at=analyseCfo({...input,priceOverride:loan.maxBuy},DEFAULT_UNDERWRITING_SETTINGS,{...params,financingMode:"LOAN",loanSchedule:"ANNUITY",loanRate:0,loanAmount:100000,loanTermMonths:12}).selected!;assert.ok(at.projectProfitBeforeTax!>=DEFAULT_UNDERWRITING_SETTINGS.minimumProfitPLN-.01);}});
test("conditional tax Q&A recalculates CEO without altering gross costs, cash ledger or net UNKNOWN",()=>{
 const keys=["DEAL_ROOM_CFO_ENABLED","DEAL_ROOM_TAX_REVIEW_ENABLED","DEAL_ROOM_TAX_ARITHMETIC_ENABLED"] as const;
 const before=keys.map(k=>process.env[k]);
 try {
  keys.forEach(k=>process.env[k]="true");const base=lodzDeal(),first=buildCanonicalDeal(base);
  const command=parseAnswerCommand({requestId:crypto.randomUUID(),expectedVersion:1,answers:[{field:"taxScenario",kind:"VALUE",value:"PRIVATE",basis:"ASSUMPTION",evidenceUrl:null},{field:"taxRule",kind:"VALUE",value:"PRIVATE_PIT19",basis:"ASSUMPTION",evidenceUrl:null},{field:"taxRuleBase",kind:"VALUE",value:"100000.00",basis:"ASSUMPTION",evidenceUrl:null}]});
  const answers=mergeAnswers(first,{version:1,answers:{},baselineOverrides:{},rounds:[]},command,"operator",base.now);
  const next=buildCanonicalDeal({...base,overrides:answerOverrides(first,{},answers)});
  assert.equal(next.underwriting.result?.cfo?.taxReview?.conditional?.amountPLN,19000);assert.equal(next.underwriting.result?.cfo?.netProfit,null);
  assert.deepEqual(next.underwriting.result?.cfo?.variants,first.underwriting.result?.cfo?.variants);assert.notEqual(next.ceo.inputFingerprint,first.ceo.inputFingerprint);assert.notEqual(next.ceo.result?.action,"KUP");assert.equal(answers.taxRuleBase.status,"NEEDS_EVIDENCE");
  for(const value of ["CIT9","__proto__"])assert.throws(()=>parseAnswerCommand({...command,answers:[{...command.answers[1],value}]}));
  assert.throws(()=>parseAnswerCommand({...command,answers:[{...command.answers[2],value:"-1"}]}));
  process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED="false";assert.throws(()=>parseAnswerCommand(command),/wyłączone/);
 } finally {keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});}
});
test("bounded PRIVATE model integrates Q&A, reanalyzes all dependent directors and keeps actual qualification UNKNOWN",async()=>{
 const {PRIVATE_ENUMS}=await import("./private-tax");
 const keys=["DEAL_ROOM_CFO_ENABLED","DEAL_ROOM_TAX_REVIEW_ENABLED","DEAL_ROOM_PRIVATE_TAX_ENABLED"] as const,old=keys.map(k=>process.env[k]);
 try{
  keys.forEach(k=>process.env[k]="true");const source=lodzDeal(),base={...source,overrides:{...params,taxScenario:"PRIVATE",taxAcquiredOn:"2026-04-01",taxSaleOn:"2026-10-01"}};
  const first=buildCanonicalDeal(base),state={version:1,answers:{},baselineOverrides:base.overrides,rounds:[]};
  const values={...PRIVATE_ENUMS,privateAcquisitionFees:"0",privateImprovements:"0",privateDisposalCosts:"0",privateQualificationRef:"https://example.test/synthetic-qualification"};
  const cmd=parseAnswerCommand({requestId:crypto.randomUUID(),expectedVersion:1,answers:Object.entries(values).map(([field,value])=>({field,value,kind:"VALUE",basis:"ASSUMPTION",evidenceUrl:null}))});
  const answers=mergeAnswers(first,state,cmd,"synthetic",base.now);const next=buildCanonicalDeal({...base,overrides:answerOverrides(first,base.overrides,answers)});
  assert.equal(first.underwriting.result?.cfo?.privateTax?.status,"UNKNOWN");assert.equal(next.underwriting.result?.cfo?.privateTax?.status,"MODELLED_ESTIMATE");
  assert.equal(next.underwriting.result?.cfo?.privateTax?.actualLiability,null);assert.equal(next.underwriting.result?.cfo?.netProfit,null);assert.notEqual(first.ceo.inputFingerprint,next.ceo.inputFingerprint);assert.notEqual(next.ceo.result?.action,"KUP");
  assert.equal(next.market.inputFingerprint,first.market.inputFingerprint);assert.equal(next.verify.inputFingerprint,first.verify.inputFingerprint);assert.deepEqual(next.underwriting.result?.cfo?.variants,first.underwriting.result?.cfo?.variants);
  const changed=affectedDirectors(["privateImprovements"]);assert.ok(changed.includes("CFO"));assert.ok(changed.includes("CEO"));
  const without=buildCanonicalDeal({...base,overrides:{...answerOverrides(first,base.overrides,answers),privateVat:null}});assert.equal(without.underwriting.result?.cfo?.privateTax?.pit,null);
  process.env.DEAL_ROOM_PRIVATE_TAX_ENABLED="false";assert.throws(()=>parseAnswerCommand(cmd),/wyłączony/);assert.equal(buildCanonicalDeal(base).underwriting.result?.cfo?.privateTax,undefined);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
