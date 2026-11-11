import assert from "node:assert/strict";
import test from "node:test";
import { assess, emptyAssessment, parseAssessment, repairCost, acquisitionBudgets, holdingCosts, financeCosts, purchaseTax, conditionOptions, estimatedApartmentNotaryGross } from "./assessment.ts";
import { emptyWorkspace, parseWorkspace } from "./model.ts";
import { plainText } from "./plain-text.ts";
function complete() { const a = emptyAssessment(); a.notaryMode="manual"; a.running.mode="total"; a.financing.mode="total"; a.taxMode="custom"; for (const r of Object.values(a.repairs)) r.condition = "ok"; Object.assign(a, { finishingRate: 100000, finishingArea: 50, furnishing: 1000000, holding: 200000, finance: 0, other: 0, purchaseFixed: 500000, saleFixed: 200000, minimumProfit: 5000000, purchasePercent: 2, salePercent: 3 }); return a; }
test("unknown inspections never silently cost zero; overrides are deliberate estimates", () => { const a = emptyAssessment(); assert.equal(assess(a, 40000000, 30000000).complete, false); const r = a.repairs.electrical; assert.equal(repairCost(r), null); r.override = 100000; assert.equal(repairCost(r),100000); r.condition="ok"; assert.equal(repairCost(r),0); r.condition="minor"; r.override=null; r.rate=12345;r.quantity=2.5;assert.equal(repairCost(r),30863); r.condition="replace"; assert.equal(repairCost(r),30863); });
test("max bid preserves required profit to the grosz after transaction percentages", () => { const a=complete(), sale=40000000; const r=assess(a,sale,30000000); assert.equal(r.complete,true); assert.equal(r.renovation,5000000); assert.equal(r.reserve,500000); assert.equal(r.saleCosts,1400000); assert.equal(r.fixed,8100000); assert.equal(r.maxPurchase,25882352); assert.ok(assess(a,sale,r.maxPurchase).profit! >= a.minimumProfit!); assert.ok(assess(a,sale,r.maxPurchase!+1).profit! < a.minimumProfit!); });
test("zero works, missing costs block decisions and impossible profit is explicit", () => { const a=complete();a.holding=null;assert.equal(assess(a,40000000,0).maxPurchase,null);a.holding=0;a.minimumProfit=50000000;assert.equal(assess(a,40000000,0).feasible,false);a.minimumProfit=0;assert.equal(assess(a,0,0).feasible,false); });
test("legacy cards and checklist survive without inventing inspection findings", () => { const old = { ...emptyWorkspace(), checklist:["Stan instalacji elektrycznej"], notes:"Moja notatka" }; delete (old as Partial<typeof old>).assessment;const w=parseWorkspace(old);assert.equal(w.notes,"Moja notatka");assert.equal(w.checklist.length,1);assert.equal(w.assessment.repairs.electrical.condition,"unknown");assert.deepEqual(parseWorkspace(w),w); });
test("assessment validates malicious and non-finite values", () => { for(const v of [-1, Infinity, NaN, 101]){const a=complete();a.salePercent=v;assert.throws(()=>parseAssessment(a));}const a=complete();a.repairs.windows.rate=1.5;assert.throws(()=>parseAssessment(a)); });
test("acquisition seeds missing budgets and preserves existing plans",()=>{const a=complete();const b=acquisitionBudgets(a,40000000,30000000,{renovation:123});assert.equal(b.renovation,123);assert.equal(b.transaction,1100000);assert.equal(b.sale,1400000);const w=emptyWorkspace();assert.deepEqual(acquisitionBudgets(emptyAssessment(),null,null,w.budgets),w.budgets);});
test("imported HTML is readable text, scripts removed, original plain notes preserved",()=>{assert.equal(plainText('<p><strong>Oferta</strong><br />42 m&#178; &amp; balkon</p><script>alert(1)</script>'), 'Oferta\n42 m² & balkon');assert.equal(plainText('Własna notatka\nKontakt'), 'Własna notatka\nKontakt');});

test("monthly bills multiply by the planned flip duration without counting the legacy total", () => {
 const a=complete();a.running={mode:"monthly",months:6,monthly:{rent:60000,electricity:15000,heating:0,other:5000}};a.holding=400000;
 assert.equal(holdingCosts(a),480000);a.running.months=9;assert.equal(holdingCosts(a),720000);a.running.monthly.heating=null;assert.equal(holdingCosts(a),null);a.running.mode="total";assert.equal(holdingCosts(a),400000);
});
test("loan principal is not an extra purchase cost; interest follows months",()=>{
 const a=complete();a.running.months=6;a.financing={mode:"loan",principal:20000000,annualPercent:12,fee:100000};assert.equal(financeCosts(a),1300000);a.running.months=3;assert.equal(financeCosts(a),700000);a.financing.mode="cash";assert.equal(financeCosts(a),0);
});
test("PCC variants are automatic and market-value override is respected",()=>{
 const a=complete();a.taxMode="resale";assert.equal(purchaseTax(a,30000000),600000);assert.equal(purchaseTax(a,12345678),246900);a.taxMode="bulk";assert.equal(purchaseTax(a,30000000),1800000);for(const mode of ["vat","exempt"] as const){a.taxMode=mode;assert.equal(purchaseTax(a,30000000),0);}a.taxMode="resale";a.taxBase=40000000;assert.equal(purchaseTax(a,30000000),800000);
});
test("maximum bid includes PCC rounding and the buyer agency commission",()=>{
 const a=complete();a.taxMode="resale";a.purchaseAgencyPercent=2.5;const r=assess(a,40000000,30000000);assert.ok(r.maxPurchase!==null);assert.ok(assess(a,40000000,r.maxPurchase).profit!>=a.minimumProfit!);assert.ok(assess(a,40000000,r.maxPurchase!+1).profit!<a.minimumProfit!);assert.equal(r.purchaseCosts,1850000);
});
test("legal and common-building costs do not increase renovation contingency",()=>{
 const a=complete();a.repairs.legal={condition:"minor",override:100000,rate:null,quantity:null};a.repairs.building={condition:"replace",override:200000,rate:null,quantity:null};const r=assess(a,40000000,30000000);assert.equal(r.risks,300000);assert.equal(r.renovation,5000000);assert.equal(r.reserve,500000);assert.equal(acquisitionBudgets(a,40000000,30000000,{}).other,300000);assert.equal(conditionOptions("legal").replace,"Problem do rozwiązania");
});
test("older flat costs survive normalization and are counted exactly once",()=>{
 const old=complete() as unknown as Record<string,unknown>;for(const k of ["running","financing","taxMode","taxBase","purchaseAgencyPercent","notaryMode","notaryExtras"])delete old[k];old.holding=400000;old.finance=150000;old.purchasePercent=0;const a=parseAssessment(old);assert.equal(a.running.mode,"total");assert.equal(a.financing.mode,"total");assert.equal(holdingCosts(a),400000);assert.equal(financeCosts(a),150000);assert.equal(a.taxMode,"resale");assert.equal(a.purchasePercent,0);assert.equal(purchaseTax(a,30000000),600000);assert.deepEqual(parseAssessment(a),a);
});
test("fractional months, invalid modes and invalid monthly charges are rejected",()=>{
 for(const mutate of [(a:ReturnType<typeof complete>)=>{a.running.months=1.5},(a:ReturnType<typeof complete>)=>{a.running.monthly.rent=-1},(a:ReturnType<typeof complete>)=>{a.financing.annualPercent=Infinity}]){const a=complete();mutate(a);assert.throws(()=>parseAssessment(a));}
});

test("automatic notary estimate uses the apartment half rate plus VAT and current tiers",()=>{
 assert.equal(estimatedApartmentNotaryGross(30000000),121155);assert.equal(estimatedApartmentNotaryGross(100000000),293355);assert.equal(estimatedApartmentNotaryGross(200000000),416355);assert.equal(estimatedApartmentNotaryGross(500000000),877605);assert.equal(estimatedApartmentNotaryGross(2000000000),1537500);
 const a=complete();a.notaryMode="estimate";a.notaryExtras=100000;assert.equal(assess(a,40000000,30000000).notary,221155);const r=assess(a,40000000,30000000);assert.ok(assess(a,40000000,r.maxPurchase).profit!>=a.minimumProfit!);assert.ok(assess(a,40000000,r.maxPurchase!+1).profit!<a.minimumProfit!);
});
test("PCC rounds the market-value base and tax to whole PLN",()=>{const a=complete();a.taxMode="resale";assert.equal(purchaseTax(a,10002449),200000);assert.equal(purchaseTax(a,10002450),200100);});
