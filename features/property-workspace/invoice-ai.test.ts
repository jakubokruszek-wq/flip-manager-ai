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
