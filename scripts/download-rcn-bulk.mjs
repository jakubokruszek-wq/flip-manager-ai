// Official municipal downloads only; no API keys or database access.
import {load} from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
const directory=path.resolve(process.argv[2]||'.rcn-proof/downloads');
await fs.mkdir(directory,{recursive:true});
const origin='https://nowa.mapa.lodz.pl';
const response=await fetch(origin+'/dla-profesjonalistow/',{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Official source page unavailable');
const $=load(await response.text());const year=new Date().getUTCFullYear();const files=[];
$('a[href]').each((_,el)=>{const href=$(el).attr('href');let url;try{url=new URL(href,origin);}catch{return;}if(url.origin!==origin||!url.pathname.startsWith('/wp-content/uploads/')||!url.pathname.toLowerCase().endsWith('.zip'))return;const filename=path.basename(url.pathname);const annual=/^(\d{4})\.zip$/i.exec(filename);const label=$(el).text().trim();if(annual?(+annual[1]>=year-3&&+annual[1]<=year):Array.from({length:4},(_,i)=>year-i).some(y=>new RegExp(`\\b${y}\\b`).test(label)))files.push({url:url.href,label,filename});});
const unique=[...new Map(files.map(f=>[f.url,f])).values()];
for(let y=year-3;y<year;y++)if(!unique.some(f=>f.filename===`${y}.zip`||new RegExp(`\\b${y}\\b`).test(f.label)))throw Error(`Official archive coverage ${y} missing`);
if(!unique.some(f=>!/^\d{4}\.zip$/.test(f.filename)))throw Error('No current-year increments');
let cursor=0;await Promise.all([0,1].map(async()=>{while(cursor<unique.length){const file=unique[cursor++];const target=path.join(directory,file.filename);let exists=false;let previous={};try{const stat=await fs.stat(target);exists=stat.size>0&&Date.now()-stat.mtimeMs<22*3600000;previous=JSON.parse(await fs.readFile(target+'.http.json','utf8'));}catch{}if(!exists){const headers={};if(previous.etag)headers['If-None-Match']=previous.etag;if(previous.modified)headers['If-Modified-Since']=previous.modified;const r=await fetch(file.url,{signal:AbortSignal.timeout(120000),redirect:'error',headers});if(r.status===304){await fs.utimes(target,new Date(),new Date());console.log(file.filename+' unchanged');continue;}if(!r.ok||Number(r.headers.get('content-length'))>80_000_000)throw Error('Archive unavailable or oversized: '+file.filename);const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>80_000_000||bytes.subarray(0,2).toString()!=='PK')throw Error('Invalid ZIP');await fs.writeFile(target+'.tmp',bytes);await fs.rename(target+'.tmp',target);await fs.writeFile(target+'.http.json',JSON.stringify({etag:r.headers.get('etag'),modified:r.headers.get('last-modified')}));}console.log(file.filename);}}));
await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({source:origin+'/dla-profesjonalistow/',checkedAt:new Date().toISOString(),files:unique},null,2));
