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

test("OCR totals follow explicit net VAT gross columns and reject inconsistent rows",()=>{
 assert.equal(invoiceDraft("Netto VAT Brutto\nRazem 1000,00 230,00 1230,00 PLN").amount,123000);
 assert.equal(invoiceDraft("Netto VAT Brutto\nRazem 1000,00 230,00 9999,00 PLN").amount,null);
 assert.equal(invoiceDraft("Brutto VAT Netto\nRazem 1230,00 230,00 1000,00 PLN").amount,null);
 assert.equal(invoiceDraft("Netto VAT Brutto\nRazem 1000,00 230,00 1230,00 EUR").amount,null);
});

test("KSeF issue-date legal caption and seller name label fill the invoice form",()=>{
 const r=invoiceDraft("Krajowy System e-Faktur\nNumer KSeF: 7740001454-20261003-EXAMPLE\nSprzedawca\nNIP: 7740001454\nNazwa: ORLEN S.A.\nAdres\nNabywca\nNazwa: Testowy klient\nSzczegóły\nData wystawienia, z zastrzeżeniem artykułu 106na ust. 1\nustawy: 2026-10-03\nKwota należności ogółem: 284,89 PLN\nData zapłaty: 2026-10-03\nDokument wydania: 123 (PV 44530K1/0009/26)");
 assert.equal(r.date,"2026-10-03");assert.equal(r.amount,28489);assert.equal(r.supplier,"ORLEN S.A. · NIP 7740001454");assert.equal(r.invoiceNumber,"");
});
test("missing issue date must not be replaced with sale or payment date",()=>{
 for(const label of ["Data dokonania dostawy", "Data sprzedaży", "Data zapłaty", "Termin płatności"])assert.equal(invoiceDraft(`Data wystawienia: nieczytelna\n${label}: 2026-10-03`).date,"");
});

test("side-by-side KSeF seller and buyer and OCR issue caption preserve the left fields",()=>{
 const r=invoiceDraft("Sprzedawca Nabywca\nNIP: 7740001454 NIP: 1234563218\nNazwa: ORLEN S.A. Nazwa: Testowy nabywca\nAdres Adres\nData wystawienla, z zastrzezeniem artykulu 106na ust. 1 Data dokonania dostawy\nustawy: 2026-10-03 wykonania usługi: 2026-10-04\nKwota naleznosci ogolem: 284,89 PLN");
 assert.equal(r.supplier,"ORLEN S.A. · NIP 7740001454");assert.equal(r.date,"2026-10-03");assert.equal(r.amount,28489);
});
