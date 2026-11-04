const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,p=require('../../main/extension/desktop-preview.js'),f=require('../../main/extension/desktop-fields.js'),ocr=require('../../main/extension/ocr-fields.js');
const id='550000000000081',nonce='12345678-1234-1234-1234-123456789012';
const message=texts=>({nonce,consent:true,groupId:'lodzsprzedazzakupwynajem',postId:id,texts});
const read=(texts,reader=ocr.create())=>reader.project(message(texts),core,f,p);
test('OCR unit price and visible area are separate heuristic fields without returning raw text',()=>{
 const r=read(['Sprzedam mieszkanie 65m2. 5383 zł/m2. Łódź-Śródmieście']);assert.equal(r.status,'OK');assert.equal(r.rows[0].area,65);assert.equal(r.rows[0].priceSource,'DERIVED_FROM_PRICE_PER_M2');assert.equal(r.rows[0].price,349895);assert.equal(r.rows[0].rooms,null);assert(!JSON.stringify(r).includes('Sprzedam'));assert(!('text'in r.rows[0]));
});
test('explicit OCR total and decimal area from the operator example survive normalization',()=>{
 const r=read(['Sprzedam mieszkanie Łódź ul. Różyckiego\n45,8 m2 260 000 zł']);assert.equal(r.rows[0].price,260000);assert.equal(r.rows[0].area,45.8);assert.equal(r.rows[0].priceSource,'EXPLICIT_TOTAL');
});
test('plural explicit area unit normalizes while distances do not become apartment area',()=>{
 const r=read(['Sprzedam mieszkanie 63 metry. 2 pokoje. Cena 5800 zł/m2']);assert.equal(r.rows[0].area,63);assert.equal(r.rows[0].rooms,2);assert.equal(r.rows[0].price,365400);
 const d=read(['Sprzedam mieszkanie. 63 metry od tramwaju. Cena 260000 zł']);assert.notEqual(d.rows[0].area,63);
});
test('multiple image conflicts are kept unresolved instead of silently selecting a price',()=>{
 const r=read(['Sprzedam mieszkanie 45m2 za 260000 zł','Sprzedam mieszkanie 45m2 za 900000 zł']);assert.equal(r.rows[0].price,null);assert.equal(r.rows[0].priceSource,'NONE');
});
test('new consent exact ID group nonce and bounded texts precede projection',()=>{
 for(const change of [{consent:false},{groupId:'../foreign'},{postId:'guessed'},{nonce:'old'},{texts:[]},{texts:['x'.repeat(12001)]},{texts:['x'.repeat(9000),'x'.repeat(9000),'x'.repeat(9000)]}])assert.equal(ocr.create().project({...message(['Sprzedam mieszkanie 42m2 za 319000 zł']),...change},core,f,p).status,'STOP');
 const reader=ocr.create();assert.equal(read(['Sprzedam mieszkanie 42m2 za 319000 zł'],reader).status,'OK');assert.equal(read(['Sprzedam mieszkanie 42m2 za 319000 zł'],reader).status,'STOP');
});

test('actual offline recognizer transcription accepts romanized zl without guessing similar glyphs',()=>{
 const text='Sprzedam mieszkanie\n45,8 m2\n260 000 zl\n2 pokoje';const r=read([text]);assert.equal(r.rows[0].price,260000);assert.equal(r.rows[0].area,45.8);assert.equal(r.rows[0].rooms,2);assert.equal(r.rows[0].priceSource,'EXPLICIT_TOTAL');
 assert.equal(read([text.replace(' zl',' z1')]).rows[0].price,null);
});

const poster='ŁÓDŹ (ul.Łagiewnicka/Goplańska) 62,4M2 - 3/3piętro z balkonem - do remontu, niski blok z 2000r. Cena 368K - chętni?';
test('actual graphic offer without sprzedam qualifies from explicit price area and residential facts',()=>{
 const r=ocr.create().project({...message([poster]),groupId:'297408205383031',postId:'1655103482946823'},core,f,p).rows[0];
 assert.equal(r.intent,'SELL_PROPERTY');assert.equal(r.usable,true);assert.equal(r.price,368000);assert.equal(r.area,62.4);assert.equal(r.rooms,null);assert(r.permalink.includes('/297408205383031/posts/1655103482946823/'));
});
test('implicit poster sale never accepts buyers rentals services comparisons foreign cities or missing total price',()=>{
 for(const text of ['Szukam mieszkania. '+poster,'Kupię mieszkanie. '+poster,'Do wynajęcia mieszkanie. '+poster,'Wykonujemy remonty mieszkań. '+poster,'Przykładowa wycena: '+poster,poster.replace('ŁÓDŹ','Warszawa'),poster.replace('Cena 368K','Cena do ustalenia')]){
  const row=read([text]).rows[0];assert(!(row.intent==='SELL_PROPERTY'&&row.usable),text);
 }
});
