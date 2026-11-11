import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { readInvoiceAi } from "./invoice-ai.ts";
const transcript="Faktura VAT nr FV/77/2026\nSprzedawca NIP 1234563218\nData wystawienia: 2026-11-11\nRazem brutto: 1234,56 PLN";
test("AI receives a PDF file only on request; totals derive from a strong gross line",async c=>{
 let sent:Record<string,unknown>={};c.mock.method(globalThis,"fetch",async (_:unknown,init:RequestInit)=>{sent=JSON.parse(String(init.body));return Response.json({output:[{content:[{type:"output_text",text:JSON.stringify({text:transcript})}]}]});});
 const draft=await readInvoiceAi(new TextEncoder().encode("%PDF-1.4 synthetic"),"fixture-key");
 assert.equal(sent.store,false);assert.equal((sent.input as Array<{content:Array<{type:string}>}>)[0].content[0].type,"input_file");assert.equal(draft.amount,123456);assert.equal(draft.invoiceNumber,"FV/77/2026");assert.equal(draft.date,"2026-11-11");
});
test("AI image input is bounded and ambiguous/net-only totals remain unknown",async c=>{
 c.mock.method(globalThis,"fetch",async (_:unknown,init:RequestInit)=>{const body=JSON.parse(String(init.body));const source=body.input[0].content[0];assert.equal(source.type,"input_image");const image=await sharp(Buffer.from(source.image_url.split(',')[1],'base64')).metadata();assert.ok(Math.max(image.width!,image.height!)<=2200);return Response.json({output_text:JSON.stringify({text:"Faktura VAT nr 77/2026\nRazem netto: 100,00 PLN\nVAT 23,00 PLN"})});});
 const image=await sharp({create:{width:2800,height:2000,channels:3,background:"white"}}).png().toBuffer();const result=await readInvoiceAi(image,"fixture-key");assert.equal(result.amount,null);
});
test("failed or malformed AI does not invent an amount",async c=>{
 c.mock.method(globalThis,"fetch",async()=>new Response("unavailable",{status:503}));await assert.rejects(()=>readInvoiceAi(new TextEncoder().encode('%PDF-fixture'),"fixture-key"));
 c.mock.method(globalThis,"fetch",async()=>Response.json({output_text:'{"text":""}'}));await assert.rejects(()=>readInvoiceAi(new TextEncoder().encode('%PDF-fixture'),"fixture-key"));
});

test("structured AI fields fill a table invoice only when backed by visible text",async c=>{
 const text="SPRZEDAWCA Sklep ABC\nDokument FV/99/2026\n11.11.2026\nNetto VAT Brutto\nRazem 1000,00 230,00 1230,00 PLN";
 c.mock.method(globalThis,"fetch",async()=>Response.json({output_text:JSON.stringify({text,supplier:"Sklep ABC",invoiceNumber:"FV/99/2026",issueDate:"2026-11-11",totalGrossText:"1230,00",totalEvidence:"Netto VAT Brutto\nRazem 1000,00 230,00 1230,00 PLN"})}));
 const r=await readInvoiceAi(new TextEncoder().encode('%PDF-fixture'),"fixture-key");assert.equal(r.supplier,"Sklep ABC");assert.equal(r.invoiceNumber,"FV/99/2026");assert.equal(r.date,"2026-11-11");assert.equal(r.amount,123000);
});
test("AI cannot fill invented fields or match a smaller number inside a gross total",async c=>{
 c.mock.method(globalThis,"fetch",async()=>Response.json({output_text:JSON.stringify({text:"Brutto\nRazem 100,00 23,00 123,00 PLN",supplier:"Invented",invoiceNumber:"INV/999",issueDate:"2026-01-01",totalGrossText:"3,00",totalEvidence:"Brutto\nRazem 100,00 23,00 123,00 PLN"})}));
 const r=await readInvoiceAi(new TextEncoder().encode('%PDF-fixture'),"fixture-key");assert.equal(r.supplier,"");assert.equal(r.invoiceNumber,"");assert.equal(r.date,"");assert.equal(r.amount,null);
});

test("AI cannot label the net column as gross using a grounded table snippet",async c=>{
 const text="Netto VAT Brutto\nRazem 1000,00 230,00 1230,00 PLN\nRazem brutto: 9999,00 PLN";
 c.mock.method(globalThis,"fetch",async()=>Response.json({output_text:JSON.stringify({text,supplier:null,invoiceNumber:null,issueDate:null,totalGrossText:"1000,00",totalEvidence:"Netto VAT Brutto\nRazem 1000,00 230,00 1230,00 PLN"})}));
 assert.equal((await readInvoiceAi(new TextEncoder().encode('%PDF-fixture'),"fixture-key")).amount,null);
});
