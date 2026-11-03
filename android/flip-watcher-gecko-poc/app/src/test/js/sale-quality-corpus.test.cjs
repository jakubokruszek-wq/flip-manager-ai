const assert=require('node:assert/strict');
const test=require('node:test');
const fields=require('../../main/extension/desktop-fields.js');
const ready=text=>{const row=fields.previewFields({postText:text});return row.intent==='SELL_PROPERTY'&&row.usable&&['CLASSIFIER','CANDIDATE','MISSING_FIELDS'].includes(row.qualification);};
test('actual pinned classifier accepts property sale including details confined to an attached text graphic',()=>{
 for(const text of ['Sprzedam mieszkanie Łódź Bałuty, 42 m2, 2 pokoje, 430000 zł','Sprzedam mieszkanie Łódź. Szczegóły na zdjęciu.'])assert.equal(ready(text),true,text);
});
test('actual pinned classifier refuses rentals, buyers, services, unrelated sales and conflicting location',()=>{
 for(const text of ['Wynajmę mieszkanie Łódź 42 m2, 2 pokoje, 2500 zł','Kupię mieszkanie Łódź 42 m2 do 430000 zł','Sprzedam samochód Łódź Bałuty ul. Zgierska 430000 zł','Usługi remontowe mieszkań Łódź 42 m2, 430000 zł','Sprzedam mieszkanie Warszawa 42 m2 za 430000 zł',''])assert.equal(ready(text),false,text);
});
