import fs from 'node:fs/promises';
import proj4 from 'proj4';
import {buildResaleCandidates} from '../features/transaction-prices/resales.ts';
import {normalizeRcnLocation} from '../features/transaction-prices/model.ts';
import {distanceMeters,pointInPolygon} from '../features/transaction-prices/geo.ts';
const [rowsPath,boundariesPath,manifestPath,target='features/transaction-prices/data/rcn-snapshot.json']=process.argv.slice(2);
if(!rowsPath||!boundariesPath||!manifestPath)throw Error('rows, boundaries and manifest required');
const rows=JSON.parse(await fs.readFile(rowsPath,'utf8'));const boundaries=JSON.parse(await fs.readFile(boundariesPath,'utf8'));const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
if(!Array.isArray(rows)||rows.length<1000||boundaries.features?.length!==5||manifest.files?.length<4)throw Error('Incomplete source input');
const CRS='+proj=tmerc +lat_0=0 +lon_0=18 +k=0.999923 +x_0=6500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const now=new Date(process.env.RCN_AS_OF||Date.now());const importedAt=now.toISOString();
const addressCache=new WeakMap();
const addr=r=>{if(addressCache.has(r))return addressCache.get(r);const value=Object.fromEntries((r.LOK_ADRES||'').split(';').map(p=>{const i=p.indexOf(':');return[p.slice(0,i),p.slice(i+1).trim()]}));addressCache.set(r,value);return value;};
const streets=new Map();const byUnit=new Map();const byTx=new Map();const byStreet=new Map();
for(const r of rows){const a=addr(r);if(normalizeRcnLocation(a.MSC||'')==='lodz'&&a.UL?.trim()){const streetKey=normalizeRcnLocation(a.UL);streets.set(streetKey,a.UL.trim());byStreet.set(streetKey,[...(byStreet.get(streetKey)||[]),r]);}if(r.LOK_ID_LOKALU)byUnit.set(r.LOK_ID_LOKALU,[...(byUnit.get(r.LOK_ID_LOKALU)||[]),r]);if(r.TRAN_LOKALNY_ID_IIP)byTx.set(r.TRAN_LOKALNY_ID_IIP,[...(byTx.get(r.TRAN_LOKALNY_ID_IIP)||[]),r]);}
const districtNames={'BAŁUTY':'Bałuty','GÓRNA':'Górna','POLESIE':'Polesie','ŚRÓDMIEŚCIE':'Śródmieście','WIDZEW':'Widzew'};
const locate=r=>{const east=Number(r._easting),north=Number(r._northing);if(!Number.isFinite(east)||!Number.isFinite(north))return null;const [longitude,latitude]=proj4(CRS,'EPSG:4326',[east,north]);if(latitude<51.55||latitude>51.95||longitude<19.1||longitude>19.8)return null;return{latitude,longitude};};
const candidates=[];let unlocatedCandidateCount=0;let allCandidateCount=0;
for(const [normalized,street]of streets){
 const matching=byStreet.get(normalized)||[];const txs=new Set();
 for(const r of matching)for(const history of byUnit.get(r.LOK_ID_LOKALU)||[])if(history.TRAN_LOKALNY_ID_IIP)txs.add(history.TRAN_LOKALNY_ID_IIP);
 const completeTxRows=[...txs].flatMap(id=>byTx.get(id)||[]);
 const result=buildResaleCandidates({city:'Łódź',street},completeTxRows,{now,fetchedAt:importedAt,truncated:false,limit:100000});
 for(const pair of result.rows){if(!pair.strongSignal)continue;allCandidateCount++;
  const matchingSales=matching.filter(r=>(r.DOK_DATA||'').slice(0,10)===pair.sellDate&&Number(r.LOK_CENA_BRUTTO)===pair.sellPrice&&Number(r.LOK_POW_UZYT)===pair.area&&addr(r).NR_PORZ===pair.building);
  const points=matchingSales.map(locate);const point=points[0];
  if(!point||points.some(p=>!p||distanceMeters(point,p)>20)){unlocatedCandidateCount++;continue;}
  const districtFeatures=boundaries.features.filter(f=>f.geometry?.type==='Polygon'&&pointInPolygon(point.longitude,point.latitude,f.geometry.coordinates));
  const district=districtFeatures.length===1?districtNames[districtFeatures[0].properties.DZIELNICA]||null:null;
  candidates.push({...pair,id:`rcn-city-${candidates.length+1}`,...point,district});
 }
}
candidates.sort((a,b)=>b.sellDate.localeCompare(a.sellDate)||b.priceIncrease-b.priceIncrease);
const latestRegistryVersion=rows.map(r=>r.TRAN_WERSJA_ID||'').sort().at(-1);
const snapshot={schemaVersion:1,importedAt,latestRegistryVersion,sourceUrl:manifest.source,boundarySourceUrl:'https://www.mapa.lodz.pl/3/rest/services/SMM/MapServer/14',archiveCount:manifest.files.length,observationCount:rows.length,locatedCandidateCount:candidates.length,unlocatedCandidateCount,candidates};
if(!candidates.length||candidates.some(p=>!p.strongSignal)||JSON.stringify(snapshot).includes('LOK_ID_LOKALU'))throw Error('No publishable matching evidence');
await fs.writeFile(target,JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({archiveCount:snapshot.archiveCount,observationCount:rows.length,allCandidateCount,located:candidates.length,unlocatedCandidateCount,latestRegistryVersion,districts:Object.fromEntries(Object.values(districtNames).map(d=>[d,candidates.filter(p=>p.district===d).length]))},null,2));

const addressMap=new Map();
for(const row of rows){const a=addr(row);const point=locate(row);if(!point||normalizeRcnLocation(a.MSC||'')!=='lodz'||!a.UL||!/^\d+[a-zA-Z]?(?:[/-]\d+[a-zA-Z]?)?$/.test(a.NR_PORZ||''))continue;const key=normalizeRcnLocation(a.UL)+'|'+a.NR_PORZ.toLowerCase();const previous=addressMap.get(key);if(previous===null)continue;if(previous&&distanceMeters(previous,point)>30){addressMap.set(key,null);continue;}if(!previous)addressMap.set(key,{street:a.UL.trim(),building:a.NR_PORZ,...point});}
const addresses=[...addressMap.values()].filter(Boolean).sort((a,b)=>a.street.localeCompare(b.street,'pl')||a.building.localeCompare(b.building));
await fs.writeFile(target.replace('rcn-snapshot.json','rcn-addresses.json'),JSON.stringify({importedAt,sourceUrl:manifest.source,addresses},null,2)+'\n');
console.log('Published address points: '+addresses.length);
