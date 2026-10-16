import test from "node:test";
import assert from "node:assert/strict";
import { privateTaxModel, PRIVATE_ENUMS, type PrivateTaxInputs, type PrivateEconomics } from "./private-tax";
export const privateInputs:PrivateTaxInputs={...PRIVATE_ENUMS,privateAcquisitionFees:"8000",privateImprovements:"40000",privateDisposalCosts:"9000",privateQualificationRef:"https://example.test/synthetic-qualification"};
export const privateDates={acquired:"2026-04-01",sale:"2026-10-01"};
export const privateEconomics:PrivateEconomics={mode:"CASH",purchase:300000,purchaseCosts:14000,embeddedPcc:6000,improvementBudget:50000,sale:450000,saleCosts:9000,projectProfit:57000,equity:500000,months:[{month:0,phase:"Zadatek",expenses:30000,funding:0,receipts:0,debtPayment:0,balance:470000},{month:1,phase:"Zakup",expenses:334000,funding:0,receipts:0,debtPayment:0,balance:136000},{month:2,phase:"Utrzymanie i wyposażenie",expenses:20000,funding:0,receipts:0,debtPayment:0,balance:116000},{month:6,phase:"Sprzedaż",expenses:9000,funding:0,receipts:450000,debtPayment:0,balance:557000}]};
test("independently worked complete private case: tax basis differs from economic profit; no second PCC/dividend",()=>{
 const r=privateTaxModel(privateInputs,privateDates,privateEconomics);assert.equal(r.status,"MODELLED_ESTIMATE");assert.equal(r.taxRevenue,441000);assert.equal(r.acquisitionBasis,314000);assert.equal(r.taxableIncome,87000);assert.equal(r.pit,16530);assert.equal(r.profitAfterPit,40470);assert.equal(r.pccReplacementDelta,0);assert.equal(r.cashFlow?.at(-1)?.balance,540470);assert.equal(r.taxPayment?.on,"2027-04-30");assert.equal(r.actualLiability,null);assert.equal(r.maxBuyAfterTax,null);
 assert.equal(r.cashFlow?.filter(row=>row.phase.includes("PIT")).length,1);assert.equal(r.cashFlow?.at(-2)?.balance,557000);assert.equal(privateEconomics.months.at(-1)?.balance,557000);
});
test("every qualifying fact, reference and cost declaration is mandatory, never inferred from PRIVATE",()=>{
 for(const key of Object.keys(privateInputs)) {const r=privateTaxModel({...privateInputs,[key]:null},privateDates,privateEconomics);assert.equal(r.status,"UNKNOWN",key);assert.equal(r.pit,null);assert.equal(r.cashFlow,null);}
 for(const reference of ["http://example.test","https://a:b@example.test","https://example.test?token=private"])assert.equal(privateTaxModel({...privateInputs,privateQualificationRef:reference},privateDates,privateEconomics).status,"UNKNOWN");
});
test("same-year reviewed interval has explicit boundaries; future/inheritance/business/loan never receives guessed zero",()=>{
 for(const dates of [{acquired:"2025-04-01",sale:"2026-10-01"},{acquired:"2026-04-01",sale:"2026-10-17"},{acquired:"2026-03-31",sale:"2026-10-01"},{acquired:"2026-10-02",sale:"2026-10-01"},{acquired:"2026-02-30",sale:"2026-10-01"}])assert.equal(privateTaxModel(privateInputs,dates,privateEconomics).status,"UNKNOWN");
 for(const mode of ["LOAN","INVESTOR"])assert.equal(privateTaxModel(privateInputs,privateDates,{...privateEconomics,mode}).status,"UNKNOWN");
 assert.equal(privateTaxModel(privateInputs,{acquired:"2026-04-01",sale:"2026-10-16"},privateEconomics).status,"MODELLED_ESTIMATE");
});
test("costs must be within gross economic ledger, with no silent inclusion of furniture, finance or reserve",()=>{
 for(const patch of [{privateAcquisitionFees:"8000.01"},{privateImprovements:"50000.01"},{privateDisposalCosts:"9000.01"},{privateImprovements:"-1"}])assert.equal(privateTaxModel({...privateInputs,...patch},privateDates,privateEconomics).status,"UNKNOWN");
 assert.equal(privateTaxModel(privateInputs,privateDates,{...privateEconomics,projectProfit:57001}).status,"UNKNOWN");
 assert.equal(privateTaxModel(privateInputs,privateDates,{...privateEconomics,sale:NaN}).status,"UNKNOWN");
});
test("explicit losses produce no refund, while an unqualified transaction remains UNKNOWN",()=>{
 const sale=300000,loss={...privateEconomics,sale,projectProfit:-93000,months:privateEconomics.months.map((r,i)=>i===3?{...r,receipts:sale,balance:407000}:r)};
 const r=privateTaxModel(privateInputs,privateDates,loss);assert.equal(r.status,"MODELLED_ESTIMATE");assert.equal(r.pit,0);assert.equal(r.profitAfterPit,-93000);assert.ok(r.taxableIncome!<0);
});
test("statutory whole-PLN PCC replaces embedded cents instead of charging both",()=>{
 const e={...privateEconomics,purchase:300025.01,purchaseCosts:14000.5,embeddedPcc:6000.5,projectProfit:56974.49,months:privateEconomics.months.map((r,i)=>i===1?{...r,expenses:334025.51}:r)};
 const r=privateTaxModel(privateInputs,privateDates,e);assert.equal(r.status,"MODELLED_ESTIMATE");assert.equal(r.pcc,6001);assert.equal(r.pccReplacementDelta,.5);assert.equal(r.taxableIncome,86973.99);assert.equal(r.pit,16525);assert.equal(r.profitAfterPit,40448.99);assert.equal(r.cashFlow?.at(-1)?.balance,540448.99);
});
