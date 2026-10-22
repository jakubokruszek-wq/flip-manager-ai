/* Isolated/native-consented local projection. No storage, upload or public page bridge. */
(function(root){
'use strict';
const statKeys=['candidates','dom','hydration','network','duplicates','rejected','ambiguous','scripts','scrollSteps','scrollMoves','requests','bytes','verified','desktop','filtered','completed','streamErrors','decodeErrors','oversize','limitSkipped','articles','mobile','scrollSeen','scrollNoRange','scrollHidden','scrollOffscreen','scrollUnbound','scrollRoot','scrollInner','scrollHit'];
const zero=()=>Object.fromEntries(statKeys.map(k=>[k,0]));
function groupURL(raw,group,fixture){try{const u=new URL(raw);return /^[A-Za-z0-9._-]{1,100}$/.test(group)&&!u.username&&!u.password&&!u.hash&&(fixture||!u.search)&&u.pathname.replace(/\/$/,'')==='/groups/'+group&&((u.protocol==='https:'&&!u.port&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))||(fixture===true&&u.protocol==='http:'&&u.hostname==='127.0.0.1'));}catch{return false;}}
function exact(raw,group){try{const u=new URL(raw);const p=u.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d{5,30})\/?$/);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)&&p?.[1]===group?p[2]:null;}catch{return null;}}
function explicitIds(body,group){const ids=new Set();let n=0;for(const m of body.matchAll(/"(?:url|permalink|permalink_url)"\s*:\s*("(?:[^"\\]|\\.)*")/g)){if(++n>400)break;try{const id=exact(JSON.parse(m[1]),group);if(id)ids.add(id);}catch{}}return ids;}
const bounded=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:null;
function createModel(core,fields,group){
 const rowKeys=['postId','permalink','layer','price','priceSource','area','rooms','district','neighborhood','street','intent','usable','photos','qualification'];
 const qualifications=['CANDIDATE','NO_TEXT','FOREIGN_CITY','NOT_PROPERTY','INTENT','MISSING_FIELDS','CONFLICT','CLASSIFIER'];
 const intents=['SELL_PROPERTY','BUY_PROPERTY','RENT_OFFER','RENT_WANTED','SERVICE','OTHER','UNKNOWN'];
 function cleanRow(r){
  if(!qualifications.includes(r?.qualification))return null;
  if(!r||Object.keys(r).some(k=>!rowKeys.includes(k))||rowKeys.some(k=>!(k in r))||exact(r.permalink,group)!==r.postId||!['DOM','HYDRATION','NETWORK','MIXED'].includes(r.layer)||!intents.includes(r.intent)||typeof r.usable!=='boolean'||!Number.isInteger(r.photos)||r.photos<0||r.photos>20)return null;
  for(const [k,min,max] of [['price',1,20000000],['area',1,9999],['rooms',1,20]])if(r[k]!==null&&(bounded(r[k],min,max)===null||(k==='rooms'&&!Number.isInteger(r[k]))))return null;
  for(const k of ['district','neighborhood','street'])if(r[k]!==null&&(typeof r[k]!=='string'||r[k].length>80||/[\u0000-\u001f]/.test(r[k])))return null;
  if(!['NONE','EXPLICIT_TOTAL','THOUSANDS_TOTAL','DERIVED_FROM_PRICE_PER_M2'].includes(r.priceSource)||(r.price===null)!==(r.priceSource==='NONE'))return null;
  return Object.fromEntries(rowKeys.map(k=>[k,r[k]]));
 }

 const rows=new Map(),blocked=new Map(),stats=zero();
 function project(r,layer){
  if(!r||!/^\d{5,30}$/.test(r.postId)||exact(r.permalink,group)!==r.postId){stats.rejected++;return null;}
  const f=fields.previewFields({postText:typeof r.text==='string'?r.text.slice(0,12000):''});
  return {postId:r.postId,permalink:'https://www.facebook.com/groups/'+group+'/posts/'+r.postId+'/',layer,
   price:bounded(f.price,1,20000000),priceSource:bounded(f.price,1,20000000)!==null?f.priceSource:'NONE',area:bounded(f.area,1,9999),rooms:bounded(f.rooms,1,20),
   district:f.district,neighborhood:f.neighborhood,street:typeof f.street==='string'?f.street.slice(0,80):null,intent:f.intent,usable:f.usable===true,
   photos:Math.min(20,Array.isArray(r.media)?r.media.length:0),qualification:f.qualification};
 }
 function merge(row){
  row=cleanRow(row);
  if(!row||exact(row.permalink,group)!==row.postId){stats.rejected++;return;}
  const old=rows.get(row.postId);
  if(!old&&rows.size>=20){stats.rejected++;return;}
  if(old){stats.duplicates++;if(old.qualification==='NO_TEXT'&&row.qualification!=='NO_TEXT')old.qualification=row.qualification;
   else if(row.qualification!=='NO_TEXT'&&old.qualification!==row.qualification)old.qualification='CLASSIFIER';
   const bad=blocked.get(row.postId)||new Set();
   for(const k of ['price','area','rooms','district','neighborhood','street']){
    if(old[k]!=null&&row[k]!=null&&old[k]!==row[k]){bad.add(k);stats.ambiguous++;}
    old[k]=bad.has(k)?null:old[k]??row[k];
   }
   if(bad.has('price'))old.priceSource='NONE';else if(old.priceSource==='NONE')old.priceSource=row.priceSource;
   if(old.intent!==row.intent&&old.intent!=='UNKNOWN'&&row.intent!=='UNKNOWN'){old.intent='UNKNOWN';old.usable=false;bad.add('intent');}
   else if(old.intent==='UNKNOWN'&&!bad.has('intent'))old.intent=row.intent;
   if(!bad.has('intent'))old.usable=old.usable||row.usable;
   if(bad.has('intent'))old.qualification='CONFLICT';
   else if(old.usable&&['SELL_PROPERTY','UNKNOWN'].includes(old.intent)&&[old.price,old.area,old.rooms].some(v=>v!==null))old.qualification='CANDIDATE';
   else if(!['SELL_PROPERTY','UNKNOWN'].includes(old.intent))old.qualification='INTENT';
   else if(['CANDIDATE','MISSING_FIELDS','CLASSIFIER'].includes(old.qualification)&&[old.price,old.area,old.rooms].every(v=>v===null))old.qualification='MISSING_FIELDS';
   old.photos=Math.max(old.photos,row.photos);if(old.layer!==row.layer)old.layer='MIXED';blocked.set(row.postId,bad);
  }else rows.set(row.postId,{...row});
  stats.candidates=rows.size;
 }
 function add(record,layer){const row=project(record,layer);if(row){stats[layer==='DOM'?'dom':layer==='HYDRATION'?'hydration':'network']++;merge(row);}}
 function hydration(texts){const source={sourceType:'GROUP',sourceId:group,sourceUrl:'https://www.facebook.com/groups/'+group+'/',allowGroupRedirect:false};
  for(const body of texts.slice(0,64)){if(typeof body!=='string'||body.length>524288)continue;stats.scripts++;const ids=explicitIds(body,group);
   let found=[];try{found=core.extractStructuredRecordsFromText(body,'HYDRATION',source,0)||[];}catch{stats.rejected++;}
   for(const r of found.slice(0,100))if(ids.has(r.postId)&&r.sourceId===group)add(r,'HYDRATION');
  }
 }
 return {add,merge,hydration,stats,rows:()=>[...rows.values()].map(r=>({...r})),clear(){rows.clear();blocked.clear();Object.assign(stats,zero());}};
}
// Same semantic feed candidates as the desktop extension, plus their bounded ancestors.
// Never scroll dialogs, comments or an arbitrary overflow widget.
function scrollContainer(w,stats=null){
 const doc=w.document,root=doc.scrollingElement;
 const cards=Array.from(doc.querySelectorAll('[role="article"],article')).filter(c=>!c.parentElement?.closest('[role="article"],article')).slice(0,100);
 const candidates=new Set();const add=node=>{if(node&&candidates.size<512)candidates.add(node);};
 const ancestors=node=>{for(let p=node,depth=0;p&&depth<32;depth++,p=p.parentElement)add(p);};
 add(root);add(doc.body);add(doc.documentElement);
 for(const node of Array.from(doc.querySelectorAll('[role="feed"],[data-pagelet*="Feed"]')).slice(0,20))ancestors(node);
 // Hit testing follows the rendered viewport rather than relying on a CSS class or shallow DOM.
 let hits=0;
 for(const [x,y] of [[.5,.25],[.5,.5],[.5,.75],[.25,.5],[.75,.5]]){
  const found=doc.elementsFromPoint?.(w.innerWidth*x,w.innerHeight*y)||[];
  const layers=Array.from(found);
  for(const node of new Set([...layers.slice(0,3),...layers.slice(-3)])){hits++;ancestors(node);}
 }
 for(const card of cards)ancestors(card.parentElement);
 const evidence={scrollSeen:candidates.size,scrollNoRange:0,scrollHidden:0,scrollOffscreen:0,scrollUnbound:0,scrollRoot:0,scrollInner:0,scrollHit:hits};
 const usable=[];
 for(const node of candidates){
  if(node.isConnected===false||node.ownerDocument&&node.ownerDocument!==doc){evidence.scrollUnbound++;continue;}
  if(node.scrollHeight-node.clientHeight<32||node.clientHeight<100){evidence.scrollNoRange++;continue;}
  const style=w.getComputedStyle?.(node);
  if(style&&/hidden|clip/.test(style.overflowY)){evidence.scrollHidden++;continue;}
  if(node===root&&(!style||style.overflowY==='visible')&&doc.body&&root!==doc.body&&/hidden|clip/.test(w.getComputedStyle?.(doc.body)?.overflowY||'')){evidence.scrollHidden++;continue;}
  if(node!==root){
   if(!style||!['auto','scroll','overlay'].includes(style.overflowY)||node.closest('[role="dialog"],[role="comment"],[data-testid*="comment"]')){evidence.scrollHidden++;continue;}
   const rect=node.getBoundingClientRect();
   if(rect.width<250||rect.bottom<=0||rect.top>=w.innerHeight||rect.right<=0||rect.left>=w.innerWidth){evidence.scrollOffscreen++;continue;}
   if(!cards.some(c=>node.contains(c))){evidence.scrollUnbound++;continue;}
  }
  usable.push({node,count:cards.filter(c=>node===root||node.contains(c)).length});
 }
 usable.sort((a,b)=>b.count-a.count||(a.node===root?-1:b.node===root?1:0)||b.node.clientHeight-a.node.clientHeight);
 const selected=usable[0]?.node||null;
 if(selected)evidence[selected===root?'scrollRoot':'scrollInner']=1;
 if(stats)for(const k of Object.keys(evidence))stats[k]=Math.max(stats[k]||0,evidence[k]);
 return selected;
}
function ownMessageText(card){
 const selector='[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-ad-rendering-role="message"]';
 const texts=new Set(Array.from(card.querySelectorAll(selector)).filter(n=>n.closest('[role="article"],article')===card&&!n.closest('[role="comment"],[data-testid*="comment"],[data-ad-rendering-role*="comment"]'))
  .map(n=>String(n.innerText||n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean));
 // Identical nested markers are one message. Distinct messages stay ambiguous.
 return texts.size===1?[...texts][0].slice(0,12000):'';
}
function readDOM(w,model,core,group){
 let bytes=0;const texts=[];for(const s of Array.from(w.document.querySelectorAll('script:not([src])')).slice(0,120)){
  const t=s.textContent||'';if(!t||t.length>524288||bytes+t.length>2097152)continue;bytes+=t.length;texts.push(t);
 }model.hydration(texts);
 const cards=Array.from(w.document.querySelectorAll('[role="article"],article')).filter(c=>!c.parentElement?.closest('[role="article"],article')).slice(0,100);
 model.stats.articles=Math.max(model.stats.articles,cards.length);
 model.stats.mobile=Math.max(model.stats.mobile,Math.min(10000,w.document.querySelectorAll('[data-mcomponent]').length));
 for(const card of cards){const links=Array.from(card.querySelectorAll('a[href]')).filter(a=>a.closest('[role="article"],article')===card).slice(0,100).map(a=>core.parsePostLink(a.href)).filter(Boolean);
  const own=links.filter(l=>l.sourceType==='GROUP'&&l.sourceId===group),ids=[...new Set(own.map(l=>l.postId))];
  if(ids.length!==1||links.some(l=>l.sourceType!=='GROUP'||l.sourceId!==group)){if(ids.length)model.stats.ambiguous++;continue;}
  const text=ownMessageText(card);
  const photos=Array.from(card.querySelectorAll('img')).filter(n=>n.closest('[role="article"],article')===card&&n.getBoundingClientRect().width>=200&&n.getBoundingClientRect().height>=100).slice(0,20).map(()=>({}));
  model.add({postId:ids[0],permalink:own[0].permalink,text,media:photos},'DOM');
 }
}
async function run(w,m,core,fields,safe,send,setAbort,notify=()=>{}){
 const empty=reason=>({status:'STOP',reason,rows:[],stats:zero()});
 if(m.consent!==true||!safe(m))return empty('CONTEXT');
 if(!Number.isSafeInteger(m.documentAfter)||!Number.isFinite(w.performance.timeOrigin)||w.performance.timeOrigin<=m.documentAfter)return {status:'WAIT_FRESH',reason:'FRESHNESS',rows:[],stats:zero()};
 const model=createModel(core,fields,m.groupId);let invalid=false,dispose=null;const end=w.performance.now()+Math.min(60000,Math.max(0,Number(m.remainingMs)||0));
 let wake;const cancelled=new Promise(r=>{wake=r;});
 const abort=()=>{if(invalid)return;invalid=true;model.clear();wake();notify({type:'desktopPreviewStop',nonce:m.nonce});void send({type:'stopDesktop',nonce:m.nonce}).catch(()=>{});};
 const pause=ms=>Promise.race([new Promise(r=>w.setTimeout(r,ms)),cancelled]);setAbort(abort);
 try{
  const info=await send({type:'desktopContext',nonce:m.nonce});if(!info?.active||info.nonce!==m.nonce||!safe(m))return empty('CONTEXT');
  dispose=w.FlipVisiblePosts.watch(w,m,abort);
  const ack=await send({type:'confirmDesktop',nonce:m.nonce,safe:true});if(!ack?.confirmed||invalid||!safe(m))return empty('CONTEXT');
  const active=async()=>{if(invalid||!safe(m)||w.performance.now()>=end)return false;const c=await send({type:'desktopContext',nonce:m.nonce});return !invalid&&safe(m)&&c?.active===true&&c.nonce===m.nonce;};
  for(let step=0;step<=5;step++){
   if(!await active())return empty('CONTEXT');readDOM(w,model,core,m.groupId);if(model.stats.candidates>=20||step===5)break;
   let container=scrollContainer(w,model.stats);
   // A freshly loaded feed can acquire its scroll extent after content_idle.
   for(let wait=0;!container&&wait<5;wait++){await pause(500);if(!await active())return empty('CONTEXT');container=scrollContainer(w,model.stats);}
   if(!container)break;
   const root=container===w.document.scrollingElement;
   const before=root?w.scrollY:container.scrollTop;
   const top=Math.max(400,Math.min(900,Math.round((root?w.innerHeight:container.clientHeight)*.85)));
   if(root)w.scrollBy({left:0,top,behavior:'instant'});else container.scrollBy({left:0,top,behavior:'instant'});
   model.stats.scrollSteps++;
   await pause(500); // measure after rendering, not immediately after scrollBy
   if((root?w.scrollY:container.scrollTop)>before)model.stats.scrollMoves++;
  }
  await pause(700);if(!await active())return empty('CONTEXT');readDOM(w,model,core,m.groupId);
  const result=await send({type:'readDesktop',nonce:m.nonce});if(invalid||!safe(m)||result?.status!=='OK')return empty('CONTEXT');
  for(const row of result.rows||[])model.merge(row);
  for(const k of ['network','requests','bytes','verified','desktop','filtered','completed','streamErrors','decodeErrors','oversize','limitSkipped'])model.stats[k]=result.stats?.[k]||0;
  model.stats.desktop=w.innerWidth>=900?1:0;
  for(const k of statKeys)model.stats[k]=Math.max(0,Math.min(k==='bytes'?4194304:10000,Math.floor(model.stats[k])));
  return {status:'OK',reason:'DONE',rows:model.rows(),stats:{...model.stats}};
 }catch{return empty('ERROR');}
 finally{setAbort(null);if(dispose)dispose();model.clear();void send({type:'stopDesktop',nonce:m.nonce}).catch(()=>{});}
}
const api={scrollContainer,ownMessageText,groupURL,exact,explicitIds,createModel,readDOM,run,statKeys,zero};if(typeof module!=='undefined')module.exports=api;root.FlipDesktopPreview=api;
})(globalThis);
