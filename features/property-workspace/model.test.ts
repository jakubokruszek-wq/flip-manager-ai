import assert from "node:assert/strict";
import test from "node:test";
import { emptyWorkspace, parseWorkspace, parseMoney, totals, isInvestment, type Expense } from "./model.ts";
import { invoiceDraft } from "./invoice-ocr.ts";
import { validateFile } from "./files.ts";
const ID = "11111111-1111-4111-8111-111111111111";
function expense(patch: Partial<Expense> = {}): Expense { return { id: ID, description: "Farba", amount: 12345, supplier: "Sklep", invoiceNumber: "FV/1", date: "2026-11-10", category: "renovation", paid: true, refund: false, fileId: null, ...patch }; }
test("viewing becomes an investment only after explicit acquisition with actual price/date", () => {
 const w = emptyWorkspace(); assert.equal(isInvestment(w.stage), false); w.stage = "acquired";
 assert.throws(() => parseWorkspace(w), /cenę i datę/); w.purchasePrice = 30_000_000; w.purchaseDate = "2026-11-10";
 assert.equal(isInvestment(parseWorkspace(w).stage), true); assert.equal(parseWorkspace(w).purchasePrice, 30_000_000);
});
test("money handles Polish spaces and commas without floating point drift", () => {
 assert.equal(parseMoney("1 234,56"), 123456); assert.equal(parseMoney("0.29"), 29); assert.equal(parseMoney(""), null);
 for (const invalid of ["-1", "NaN", "1e6", "1,234", "12abc", "Infinity", "1.000.00"]) assert.throws(() => parseMoney(invalid));
});
test("purchase, paid and unpaid costs and refunds are counted once, while absent sale stays unknown", () => {
 const w = emptyWorkspace(); w.purchasePrice = 30_000_000;
 w.expenses = [expense(), expense({ id: "22222222-2222-4222-8222-222222222222", amount: 20000, invoiceNumber: "FV/2", paid: false }), expense({ id: "33333333-3333-4333-8333-333333333333", invoiceNumber: "K/1", amount: 2345, refund: true })];
 const t = totals(w); assert.equal(t.committed, 30000); assert.equal(t.paid, 10000); assert.equal(t.unpaid, 20000); assert.equal(t.cost, 30_030_000); assert.equal(t.profit, null); assert.equal(t.budgetComplete, false);
 w.expectedSalePrice = 35_000_000; assert.equal(totals(w).profit, null);
 for (const key of Object.keys(w.budgets)) w.budgets[key as keyof typeof w.budgets] = 0;
 w.budgets.renovation = 1_000_000;
 assert.equal(totals(w).estimatedCost, 31_000_000);
 assert.equal(totals(w).profit, 4_000_000);
 w.stage = "sold"; w.salePrice = 34_000_000; assert.equal(totals(w).profit, 3_970_000);
});
test("same invoice, same attachment and same expense id cannot be counted twice", () => {
 for (const other of [expense(), expense({ id: "22222222-2222-4222-8222-222222222222", supplier: " SKLEP ", invoiceNumber: " fv/1 " })]) {
  const w = emptyWorkspace(); w.expenses = [expense(), other]; assert.throws(() => parseWorkspace(w), /już zapisane/);
 }
 const w = emptyWorkspace(); w.expenses = [expense({ fileId: ID }), expense({ id: "22222222-2222-4222-8222-222222222222", invoiceNumber: "FV/2", fileId: ID })]; assert.throws(() => parseWorkspace(w), /już zapisane/);
});
test("different invoice numbers from the same supplier remain separate", () => {
 const w = emptyWorkspace(); w.expenses = [expense(), expense({ id: "22222222-2222-4222-8222-222222222222", invoiceNumber: "FV/2" })]; assert.equal(parseWorkspace(w).expenses.length, 2);
});
test("malformed amounts, dates, flags and unknown stage are rejected", () => {
 for (const patch of [{ stage: "__proto__" }, { stage: "imagined" }, { purchaseDate: "2026-02-30" }, { purchasePrice: NaN }, { purchasePrice: -1 }]) assert.throws(() => parseWorkspace({ ...emptyWorkspace(), ...patch }));
 assert.throws(() => parseWorkspace({ ...emptyWorkspace(), expenses: [expense({ paid: "yes" as unknown as boolean })] }));
 const w = emptyWorkspace(); w.stage = "sold"; w.purchasePrice = 100; w.purchaseDate = "2026-01-01"; assert.throws(() => parseWorkspace(w), /cenę i datę sprzedaży/);
});
test("uncertain OCR totals stay empty instead of guessing VAT or line items", () => {
 assert.equal(invoiceDraft("Towar 20,00\nVAT 4,60\nDo zapłaty: 24,60 PLN").amount, 2460);
 assert.equal(invoiceDraft("Towar 20,00\nVAT 4,60").amount, null);
 assert.equal(invoiceDraft("Razem brutto: 20,00 24,60").amount, null);
 assert.equal(invoiceDraft("Faktura VAT nr FV/123/2026\nData wystawienia: 2026-11-10").invoiceNumber, "FV/123/2026");
});
test("uploads inspect bytes and reject active content and PDFs in photo-only categories", () => {
 assert.equal(validateFile(new Uint8Array([255, 216, 255, 1]), "before").mime, "image/jpeg");
 const pdf = new TextEncoder().encode("%PDF-1.4 sample"); assert.equal(validateFile(pdf, "deed").extension, "pdf");
 assert.throws(() => validateFile(pdf, "before")); assert.throws(() => validateFile(new TextEncoder().encode("<svg onload='alert(1)'>"), "invoice")); assert.throws(() => validateFile(pdf, "__proto__"));
});
