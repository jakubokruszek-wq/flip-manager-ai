import test from "node:test";
import assert from "node:assert/strict";
import { conditionalTax, validTaxAmount } from "./tax-arithmetic";
import { buildTaxReview } from "./tax-review";

test("independent statutory-rate vectors: income base, company layer and separate dividend layer", () => {
 for (const rule of ["PRIVATE_PIT19", "JDG_LINEAR19", "COMPANY_CIT19"]) assert.equal(conditionalTax(rule,"100000")?.amountPLN,19000);
 // Separate legal bases, never treat sales receipts/returned capital as a dividend.
 assert.equal(conditionalTax("DIVIDEND_PIT19","81000")?.amountPLN,15390);
 assert.equal(100000-19000-15390,65610);
});
test("PCC market-value rates are alternatives, not cumulative; VAT is gross invoice split only", () => {
 assert.equal(conditionalTax("PCC2","300000")?.amountPLN,6000);
 assert.equal(conditionalTax("PCC6","300000")?.amountPLN,18000);
 for (const [rule,gross,tax] of [["VAT_GROSS23","123000",23000],["VAT_GROSS8","108000",8000]] as const) {
  const r=conditionalTax(rule,gross)!;assert.equal(r.amountPLN,tax);assert.equal(r.netInvoicePLN,100000);
  assert.equal(r.actualLiabilityPLN,null);assert.equal(r.applicability,"UNKNOWN");
 }
});
test("full-zloty base and tax rounding; invoice cents conserve gross even near boundaries", () => {
 for(const [base,tax] of [["100.49",19],["100.50",19],["102.50",20],["0",0]] as const) assert.equal(conditionalTax("PRIVATE_PIT19",base)?.amountPLN,tax);
 const vat=conditionalTax("VAT_GROSS23","0.03")!;assert.equal(vat.amountPLN,.01);assert.equal(vat.netInvoicePLN,.02);
 assert.equal(conditionalTax("DIVIDEND_PIT19","100.49")?.inputPLN,100.49);
});
test("unsupported exemptions/regimes, malformed or negative bases never produce zero liability", () => {
 for(const rule of ["CIT9","ESTONIAN","PRIVATE_EXEMPT","VAT_EXEMPT","__proto__"])assert.equal(conditionalTax(rule,"100000"),null);
 for(const amount of ["-1","NaN","Infinity","1e5","1,00","100000000.01","0.001"," 1","01","", "1.239"]) {assert.equal(validTaxAmount(amount),false);assert.equal(conditionalTax("PCC2",amount),null);}
 assert.equal(validTaxAmount("100000000.00"),true);
});
test("projection is gated, scenario-bound and cannot turn arithmetic into net profit or approved law", () => {
 const before=process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED;
 try {
  process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED="false";
  const inputs={taxScenario:"PRIVATE",taxRule:"PRIVATE_PIT19",taxRuleBase:"100000"};
  assert.equal(buildTaxReview(inputs,"2026-10-16").conditional,undefined);
  process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED="true";
  const r=buildTaxReview(inputs,"2026-10-16");assert.equal(r.conditional?.amountPLN,19000);assert.equal(r.status,"UNKNOWN");assert.equal(r.roiAfterTax,null);assert.ok(r.regimes.every(v=>v.profitAfterTax===null));
  assert.equal(buildTaxReview({...inputs,taxScenario:"JDG"},"2026-10-16").conditional,null);
  assert.equal(buildTaxReview({...inputs,taxRuleBase:null},"2026-10-16").conditional,null);
 } finally {if(before===undefined)delete process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED;else process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED=before;}
});
