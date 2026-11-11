import test from "node:test";
import assert from "node:assert/strict";
import { invoiceDraft, invoiceDate } from "./invoice-fields.ts";
test("realistic invoice labels split across rows fill all available fields",()=>{
 const r=invoiceDraft("Sprzedawca:\nSklep Budowlany ABC sp. z o.o.\nNIP: 1234563218\nNabywca: Testowy klient\nFAKTURA VAT nr:\nFV/777/2026\nData wystawienia:\n11.11.2026\nWartość brutto:\n1.234,56 PLN");
 assert.equal(r.amount,123456);assert.equal(r.invoiceNumber,"FV/777/2026");assert.equal(r.date,"2026-11-11");assert.match(r.supplier,/Sklep Budowlany ABC/);assert.match(r.supplier,/1234563218/);
});
test("payable and sum labels, integer PLN and decimal grouping stay exact",()=>{
 for(const s of ["Do zapłaty\n1 234,56 PLN","Suma brutto: 1234.56 zł","Razem 1234,56 PLN"])assert.equal(invoiceDraft(s).amount,123456,s);
 assert.equal(invoiceDraft("Razem brutto: 1000 PLN").amount,100000);
 assert.equal(invoiceDraft("Razem brutto: 1234,56 EUR").amount,null);
 assert.equal(invoiceDraft("Razem brutto: 20,00 24,60").amount,null);
 assert.equal(invoiceDraft("Netto 100,00\nVAT 23,00").amount,null);
});
test("seller selection does not take the buyer and dates must exist",()=>{
 const r=invoiceDraft("Nabywca: Kupujący\nNIP: 1234563218\nSprzedawca:\nSklep XYZ\nData faktury: 11/11/2026\nDo zapłaty: 24,60 PLN");assert.equal(r.supplier,"Sklep XYZ");assert.equal(r.date,"2026-11-11");assert.equal(invoiceDate("31.02.2026"),"");
});
