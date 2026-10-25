/* Deterministic browser bundle of the existing PURE property rules. No server imports. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const root=path.resolve(__dirname,'../../..'),base=path.resolve(__dirname,'../app/src/main/extension');
const sources=['features/facebook-watcher/extract-facebook-property.ts','features/facebook-watcher/facebook-intent.ts','features/facebook-watcher/extract-facebook-listing.ts','features/facebook-watcher/facebook-location-quality.ts'];
const texts=sources.map(p=>fs.readFileSync(path.join(root,p),'utf8'));
const pins=Object.fromEntries(sources.map((p,i)=>[p,crypto.createHash('sha256').update(texts[i]).digest('hex')]));
const pinFile=path.join(__dirname,'desktop-fields-pins.json');
if(process.argv.includes('--write-pins'))fs.writeFileSync(pinFile,JSON.stringify(pins,null,2)+'\n');
if(JSON.stringify(pins)!==JSON.stringify(JSON.parse(fs.readFileSync(pinFile,'utf8'))))throw Error('Upstream property rules changed: explicit review required');
const prop=texts[0],prefix=prop.slice(prop.indexOf('const PLACES'),prop.indexOf('export async function extractFacebookProperty'));
const body=prop.slice(prop.indexOf('  const text = input.postText'),prop.indexOf('  const street = extractPolishStreet(text);'));
const estate=texts[2].split('\n').find(x=>x.includes('const realEstateLanguage = /'));
if(!body||!estate)throw Error('Upstream extraction anchors changed');
const location=texts[3].slice(texts[3].indexOf('export function explicitPolishCity'),texts[3].indexOf('function locationConfidence'));
// POC-only notation adapter. Upstream intent, price, rooms and city rules stay pinned.
const colloquialArea=String.raw`function normalizePreviewArea(text) {
 if(typeof text!=='string'||text.length>12000)return typeof text==='string'?text:'';
 const normalized=text.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l');
 if(!/\b(?:zl|pln)\s*\/\s*m2\b/u.test(normalized)||!/\b[1-9]\d?\s*(?:pokoje|pokoi|pokoj|pokojowe)\b/u.test(normalized))return text;
 // Never override an explicit square-metre value or resolve a conflict by order.
 if(/\d\s*m(?:2|²)(?![\p{L}\d])/iu.test(text))return text;
 const candidates=[...text.matchAll(/(?<![\p{L}\d.,])(\d{1,3}(?:[.,]\d{1,2})?)\s+metr(?:y|ów|ow)\b(?=\s*(?:[·•;|,\n]|$))/giu)];
 if(candidates.length!==1)return text;
 const m=candidates[0],value=Number(m[1].replace(',','.'));
 if(!Number.isFinite(value)||value<10||value>300)return text;
 const prefix=normalized.slice(Math.max(0,m.index-64),m.index);
 if(/odleglos|dystans|przystan|autobus|tramwaj|ogrodzeni|odcinek|drogi|chodnik/u.test(prefix))return text;
 return text.slice(0,m.index)+m[1]+' m2'+text.slice(m.index+m[0].length);
}
`;
const adaptedBody=body.replace('const text = input.postText ?? "";', 'const text = normalizePreviewArea(input.postText ?? "");');
const code=texts[1]+'\n'+location+'\n'+prefix+'\n'+colloquialArea+'\nfunction previewFields(input) {\n'+adaptedBody+`\n const intent=resolveFacebookListingIntent(text,null,null).intent;
 const concrete=!['BUY_PROPERTY','RENT_WANTED','SERVICE','OTHER'].includes(intent);
 const sale=intent==='SELL_PROPERTY'||intent==='UNKNOWN';
 const street=extractPolishStreet(text);
 const district=place?.[2]??districtFound;
 const neighborhood=place?.[1]??null;
 const rooms=explicitRoomCount??(mRooms?Math.max(1,mRooms-1):null);
 ${estate}
 const explicitCity=explicitPolishCity(text);
 const foreignCity=explicitCity!==null&&explicitCity!=='Łódź';
 const usable=!foreignCity&&(realEstateLanguage||[price.price,effectiveArea,rooms,neighborhood,district,street].filter(x=>x!==null).length>=3);
 const hasFields=[sale?price.price:null,concrete?effectiveArea:null,concrete?rooms:null].some(v=>v!==null);
 const qualification=!text.trim()?'NO_TEXT':!sale?'INTENT':foreignCity?'FOREIGN_CITY':!usable?'NOT_PROPERTY':!hasFields?'MISSING_FIELDS':'CANDIDATE';
 return {qualification,price:sale?price.price:null,priceSource:sale?price.source:'NONE',area:concrete?effectiveArea:null,rooms:concrete?rooms:null,district:foreignCity?null:district,neighborhood:foreignCity?null:neighborhood,street,intent,usable};
}\n`;
const js=stripTypeScriptTypes(code,{mode:'strip'}).replace(/^export /gm,'');
const output='/* Generated from pinned existing property rules; scripts/desktop-fields.cjs --check */\n(function(root){\n"use strict";\n'+js+'\nconst api={previewFields};if(typeof module!=="undefined")module.exports=api;root.FlipDesktopFields=api;\n})(globalThis);\n';
const file=path.join(base,'desktop-fields.js');
if(process.argv.includes('--check')){if(fs.readFileSync(file,'utf8')!==output)throw Error('Generated desktop fields differ');console.log('Pinned desktop property rules PASS');}
else fs.writeFileSync(file,output);
