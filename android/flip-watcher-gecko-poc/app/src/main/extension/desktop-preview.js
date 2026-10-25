/* Isolated/native-consented local projection. No storage, upload or public page bridge. */
(function(root){
'use strict';
const statKeys=['candidates','dom','hydration','network','duplicates','rejected','ambiguous','scripts','scrollSteps','scrollMoves','requests','bytes','verified','desktop','filtered','completed','streamErrors','decodeErrors','oversize','limitSkipped','articles','mobile','scrollSeen','scrollNoRange','scrollHidden','scrollOffscreen','scrollUnbound','scrollRoot','scrollInner','scrollHit','scrollElapsedMs','scrollStalls','scrollAtEnd','scrollNoTarget','scrollTailAttempts','scrollTailMoves','pageFocused','pageVisible','scrollNativeSteps','scrollNativeMoves','photoPreviewFrames','photoPreviews','viewportHeight','visualViewportHeight','rootRemaining','viewportModule','viewportGranted','viewportReady','viewportProbeCode','nativeRequests','nativeRejected','nativeTimeout','pointMisses','mediaBindingPosts','pointProbes','pointEmpty','pointFrame','pointForeign','pointForm','pointDialog','pointComment','pointCommentable','pointChrome','pointUnbound','pointWidget','pointCache','pointCacheCards','pointRects','viewportWidth','visualWidth','visualOffsetX','visualOffsetY','visualScale100','gestureRequested','gestureTouches','gestureAnchored','gestureRejected','gestureWaitMs','gestureScrollSteps','gestureScrollMoves','noticeDetected','noticeClosed','noticeReason','noticeModals','noticeVisible','noticeNameSource','photoExactCards','photoNetworkCards','photoSources','photoIdentityRejected','photoUnready','photoGeometryRejected','photoOccluded','photoAlreadyDone','photoSelected','photoRawImg','photoRawSvg','photoRawCss','photoOwnerRejected','photoScopeRejected','photoAnchorRejected','photoSizeRejected','photoSourceRejected','photoCssUnready','scrollFast','scrollCadenceMs','photoNetworkAnchors','photoSvgBounds','photoTinyBound'];
const zero=()=>Object.fromEntries(statKeys.map(k=>[k,0]));
function groupURL(raw,group,fixture){try{const u=new URL(raw);return /^[A-Za-z0-9._-]{1,100}$/.test(group)&&!u.username&&!u.password&&!u.hash&&(fixture||!u.search)&&u.pathname.replace(/\/$/,'')==='/groups/'+group&&((u.protocol==='https:'&&!u.port&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))||(fixture===true&&u.protocol==='http:'&&u.hostname==='127.0.0.1'));}catch{return false;}}
function exact(raw,group){try{const u=new URL(raw);const p=u.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d{5,30})\/?$/);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)&&p?.[1]===group?p[2]:null;}catch{return null;}}
function explicitIds(body,group){const ids=new Set();let n=0;for(const m of body.matchAll(/"(?:url|permalink|permalink_url)"\s*:\s*("(?:[^"\\]|\\.)*")/g)){if(++n>400)break;try{const id=exact(JSON.parse(m[1]),group);if(id)ids.add(id);}catch{}}return ids;}
const bounded=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:null;
// Private bounded image evidence. No URL/media key leaves the extension model.
function imageURL(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.port||u.username||u.password||!['facebook.com','fbcdn.net'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))||/\.(?:mp4|webm|m3u8)(?:$|\/)/i.test(u.pathname)||u.pathname.length>2048)return null;return u.origin+u.pathname;}catch{return null;}}
function photoLinkId(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.port||u.username||u.password||!['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))return null;
 const id=/^\/photo(?:\.php)?\/?$/.test(u.pathname)?u.searchParams.get('fbid'):u.pathname.match(/^\/(?:[^/]+\/)?photos\/(?:(?:a|pcb)\.\d{5,30}\/)?(\d{5,30})\/?$/)?.[1];return /^\d{5,30}$/.test(id||'')?id:null;}catch{return null;}}
// Discovery uses null, never a fabricated post ID. A permalink wrapper remains
// evidence to check against the independently parsed network media owner.
// Read already rendered CSS images only. Never create an Image or fetch a URL.
function cssPhotoSource(node){
 const view=node.ownerDocument?.defaultView;
 if(!view||node.childElementCount!==0||(node.textContent||'').trim())return null;
 for(const pseudo of ['::before','::after']){const c=view.getComputedStyle(node,pseudo)?.content;if(c&&c!=='none'&&c!=='normal'&&c!=='""')return null;}
 const value=view.getComputedStyle(node)?.backgroundImage||'';
 if(value.length>8192)return null;
 const m=value.match(/^url\((?:"([^"\\]*)"|'([^'\\]*)'|([^()'"\\\s]+))\)$/);return m?(m[1]||m[2]||m[3]):null;
}
function cssPhotoLoaded(node,raw){
 if(!raw)return false;const doc=node.ownerDocument;
 // A decoded matching image or completed resource is evidence of an existing
 // page load, not permission to issue a new media request.
 if(Array.from(doc?.images||[]).slice(0,500).some(n=>(n.currentSrc||n.src)===raw&&n.complete===true&&n.naturalWidth>0))return true;
 return (doc?.defaultView?.performance?.getEntriesByName?.(raw)||[]).slice(0,20).some(e=>e.entryType==='resource'&&e.responseEnd>0&&['css','img'].includes(e.initiatorType));
}
// An opaque photo route is only a wrapper, never an ID or post association.
function opaquePhotoLink(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)&&(/^\/photo(?:\.php)?\/?$/.test(u.pathname)||/^\/(?:[^/]+\/)?photos\//.test(u.pathname));}catch{return false;}}
function photoSvgRoot(n){
 if(String(n.tagName).toLowerCase()!=='image')return null;
 const svg=n.closest?.('svg');
 if(!svg||svg.ownerDocument!==n.ownerDocument||!svg.contains?.(n)||svg.querySelectorAll('image').length!==1||svg.querySelector('text,foreignObject,path,rect,circle,ellipse,line,polygon,polyline,use'))return null;
 return svg;
}
// SVGAnchorElement.href is SVGAnimatedString, unlike HTMLAnchorElement.href.
// Use the displayed animated value and resolve relative links without coercing objects.
function photoAnchorHref(anchor){
 if(!anchor)return null;
 try{const value=anchor.href;const raw=typeof value==='string'?value:typeof value?.animVal==='string'?value.animVal:typeof value?.baseVal==='string'?value.baseVal:anchor.getAttribute?.('href');
  return typeof raw==='string'&&raw.length>0&&raw.length<=8192?new URL(raw,anchor.ownerDocument?.baseURI).href:null;
 }catch{return null;}
}
function photoNodes(card,postId,group,core,audit=null){
 const count=k=>{if(audit)audit[k]=Math.min(10000,(audit[k]||0)+1);};
 const result=[];const video=!!card.querySelector?.('video');
 const native=Array.from(card.querySelectorAll('img,svg image')).slice(0,100);
 const css=Array.from(card.querySelectorAll('[style*="background"],[role="img"]')).slice(0,100).filter(n=>!native.includes(n));
 for(const n of [...native,...css]){
  const background=css.includes(n);count(background?'photoRawCss':n.tagName==='IMG'?'photoRawImg':'photoRawSvg');
  if(n.closest('[role="article"],article')!==card){count('photoOwnerRejected');continue;}
  if(n.closest('[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],video')){count('photoScopeRejected');continue;}
  const svg=photoSvgRoot(n),renderNode=svg||n;const rect=renderNode.getBoundingClientRect();const a=n.closest('a[href]'),anchorHref=photoAnchorHref(a);const mediaId=photoLinkId(anchorHref);let linkedPostId=null,networkAnchor=false;
  if(a&&!mediaId){const p=core.parsePostLink(anchorHref);
   if(p){if(p.sourceType!=='GROUP'||p.sourceId!==group||(postId!==null&&p.postId!==postId)){count('photoAnchorRejected');continue;}linkedPostId=p.postId;}
   else if(opaquePhotoLink(anchorHref))networkAnchor=true;
   else{count('photoAnchorRejected');continue;}
  }
  if(rect.width<60||rect.height<60){count('photoSizeRejected');continue;}
  if(!mediaId&&video){count('photoScopeRejected');continue;}
  const source=()=>background?cssPhotoSource(n):n.currentSrc||n.getAttribute?.('src')||n.getAttribute?.('href')||n.getAttributeNS?.('http://www.w3.org/1999/xlink','href');
  const raw=source(),url=imageURL(raw);if(!mediaId&&!url){count('photoSourceRejected');continue;}
  if(background&&(!raw||!cssPhotoLoaded(n,raw))){count('photoCssUnready');continue;}
  // Unlinked small tiles require independent exact network-media ownership.
  // They cannot inflate DOM-only image evidence or adopt an avatar by size.
  const networkRequired=networkAnchor||rect.width<80||rect.height<80||(!mediaId&&!linkedPostId&&(rect.width<200||rect.height<100));
  if(networkRequired&&!url){count('photoSourceRejected');continue;}
  if(networkAnchor)count('photoNetworkAnchors');if(svg)count('photoSvgBounds');if(rect.width<80||rect.height<80)count('photoTinyBound');
  result.push({node:renderNode,source,ready:()=>n.isConnected!==false&&n.closest('[role="article"],article')===card&&n.closest('a[href]')===a&&photoAnchorHref(a)===anchorHref&&!n.closest('[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],video')&&(!svg||photoSvgRoot(n)===svg)&&(!background||cssPhotoLoaded(n,source())),item:{url,mediaId,linkedPostId,networkRequired,exactPostId:postId,exactAssociation:postId!==null,domPhoto:true}});if(result.length===20)break;
 }
 return result;
}
function domPhotos(card,postId,group,core){return photoNodes(card,postId,group,core).filter(p=>!p.item.networkRequired).map(p=>p.item);}
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

 const rows=new Map(),blocked=new Map(),photoEvidence=new Map(),stats=zero();
 function photos(record,layer){
  let evidence=photoEvidence.get(record.postId);
  if(!evidence){if(photoEvidence.size>=20)return 0;evidence={ids:new Set(),urls:new Map()};photoEvidence.set(record.postId,evidence);}
  for(const item of (Array.isArray(record.media)?record.media:[]).slice(0,100)){
   if(item?.exactAssociation!==true||item.exactPostId!==record.postId)continue;
   const id=typeof item.mediaId==='string'&&/^\d{5,30}$/.test(item.mediaId)?item.mediaId:null,url=imageURL(item.url);
   if(!url&&!(layer==='DOM'&&item.domPhoto===true&&id))continue;
   if(id&&evidence.ids.size<20)evidence.ids.add(id);
   if(url&&(evidence.urls.has(url)||evidence.urls.size<20)){
    const prior=evidence.urls.get(url);evidence.urls.set(url,prior||id||null);
   }
  }
  return Math.min(20,evidence.ids.size+[...evidence.urls.values()].filter(id=>!id).length);
 }
 function unresolved(row){return ['SELL_PROPERTY','UNKNOWN'].includes(row.intent)&&['NO_TEXT','MISSING_FIELDS','NOT_PROPERTY','CLASSIFIER'].includes(row.qualification);}
 function eligible(row){return row.usable===true&&['SELL_PROPERTY','UNKNOWN'].includes(row.intent)&&[row.price,row.area,row.rooms].some(v=>v!==null);}
 // Keep the bounded preview useful without replacing a retained offer or media evidence.
 function admit(row){
  if(rows.has(row.postId)||rows.size<20)return true;
  const review=row.photos>0&&unresolved(row);
  const victim=eligible(row)||review?[...rows.values()].find(old=>unresolved(old)&&!eligible(old)&&old.photos===0&&!blocked.get(old.postId)?.size):null;
  if(!victim){stats.rejected++;return false;}
  rows.delete(victim.postId);blocked.delete(victim.postId);photoEvidence.delete(victim.postId);return true;
 }
 function project(r,layer){
  if(!r||!/^\d{5,30}$/.test(r.postId)||exact(r.permalink,group)!==r.postId){stats.rejected++;return null;}
  // A shared/quoted story's message is not the enclosing post's own message.
  const path=r.__structuredDiagnostics?.structuredTextPath;
  const borrowed=layer!=='DOM'&&typeof path==='string'&&/(?:^|\.)(?:[^.]*shared[^.]*|[^.]*quoted[^.]*|crosspost[^.]*|reshare[^.]*|original_story|attached_story)(?:\.|$)/i.test(path);
  const f=fields.previewFields({postText:!borrowed&&typeof r.text==='string'?r.text.slice(0,12000):''});
  const row={postId:r.postId,permalink:'https://www.facebook.com/groups/'+group+'/posts/'+r.postId+'/',layer,
   price:bounded(f.price,1,20000000),priceSource:bounded(f.price,1,20000000)!==null?f.priceSource:'NONE',area:bounded(f.area,1,9999),rooms:bounded(f.rooms,1,20),
   district:f.district,neighborhood:f.neighborhood,street:typeof f.street==='string'?f.street.slice(0,80):null,intent:f.intent,usable:f.usable===true,
   photos:Number(!borrowed&&(Array.isArray(r.media)?r.media:[]).slice(0,100).some(item=>item?.exactAssociation===true&&item.exactPostId===r.postId&&(imageURL(item.url)||(layer==='DOM'&&item.domPhoto===true&&typeof item.mediaId==='string'&&/^\d{5,30}$/.test(item.mediaId))))),qualification:f.qualification};
  if(!cleanRow(row)){stats.rejected++;return null;}
  if(!admit(row))return null;row.photos=photos(borrowed?{...r,media:[]}:r,layer);return row;
 }
 function merge(row){
  row=cleanRow(row);
  if(!row||exact(row.permalink,group)!==row.postId){stats.rejected++;return false;}
  const old=rows.get(row.postId);
  if(!old&&!admit(row))return false;
  if(old){stats.duplicates++;const foreign=old.qualification==='FOREIGN_CITY'||row.qualification==='FOREIGN_CITY';if(old.qualification==='NO_TEXT'&&row.qualification!=='NO_TEXT')old.qualification=row.qualification;
   else if(row.qualification!=='NO_TEXT'&&old.qualification!==row.qualification)old.qualification='CLASSIFIER';
   const bad=blocked.get(row.postId)||new Set();if(foreign)bad.add('foreignCity');
   for(const k of ['price','area','rooms','district','neighborhood','street']){
    if(old[k]!=null&&row[k]!=null&&old[k]!==row[k]){bad.add(k);stats.ambiguous++;}
    old[k]=bad.has(k)?null:old[k]??row[k];
   }
   if(bad.has('price'))old.priceSource='NONE';else if(old.priceSource==='NONE')old.priceSource=row.priceSource;
   if(old.intent!==row.intent&&old.intent!=='UNKNOWN'&&row.intent!=='UNKNOWN'){old.intent='UNKNOWN';old.usable=false;bad.add('intent');}
   else if(old.intent==='UNKNOWN'&&!bad.has('intent'))old.intent=row.intent;
   if(!bad.has('intent')&&!bad.has('foreignCity'))old.usable=old.usable||row.usable;
   if(bad.has('foreignCity'))old.usable=false;
   if(bad.has('intent'))old.qualification='CONFLICT';
   else if(bad.has('foreignCity'))old.qualification='FOREIGN_CITY';
   else if(old.usable&&['SELL_PROPERTY','UNKNOWN'].includes(old.intent)&&[old.price,old.area,old.rooms].some(v=>v!==null))old.qualification='CANDIDATE';
   else if(!['SELL_PROPERTY','UNKNOWN'].includes(old.intent))old.qualification='INTENT';
   else if(['CANDIDATE','MISSING_FIELDS','CLASSIFIER'].includes(old.qualification)&&[old.price,old.area,old.rooms].every(v=>v===null))old.qualification='MISSING_FIELDS';
   old.photos=Math.max(old.photos,row.photos);if(old.layer!==row.layer)old.layer='MIXED';blocked.set(row.postId,bad);
  }else rows.set(row.postId,{...row});
  stats.candidates=rows.size;return true;
 }
 function add(record,layer){const row=project(record,layer);if(row){stats[layer==='DOM'?'dom':layer==='HYDRATION'?'hydration':'network']++;merge(row);const stored=rows.get(row.postId);if(stored&&row.photos>0)stored.photos=row.photos;}}
 function hydration(texts){const source={sourceType:'GROUP',sourceId:group,sourceUrl:'https://www.facebook.com/groups/'+group+'/',allowGroupRedirect:false};
  for(const body of texts.slice(0,64)){if(typeof body!=='string'||body.length>524288)continue;stats.scripts++;const ids=explicitIds(body,group);
   let found=[];try{found=core.extractStructuredRecordsFromText(body,'HYDRATION',source,0)||[];}catch{stats.rejected++;}
   for(const r of found.slice(0,100))if(ids.has(r.postId)&&r.sourceId===group)add(r,'HYDRATION');
  }
 }
 function mediaBindings(){
  const result=[];
  for(const [postId,e] of photoEvidence)if(rows.has(postId))result.push({postId,ids:[...e.ids],urls:[...e.urls.keys()]});
  return result;
 }
 return {add,merge,hydration,mediaBindings,stats,rows:()=>[...rows.values()].map(r=>({...r})),clear(){rows.clear();blocked.clear();photoEvidence.clear();Object.assign(stats,zero());}};
}
// Snapshot signatures belong only to the currently retained bounded rows.
function mergeSnapshot(model,cache,row){
 const signature=JSON.stringify(row);
 const accepted=cache.get(row.postId)===signature||model.merge(row)===true;
 const ids=new Set(model.rows().map(r=>r.postId));
 for(const id of cache.keys())if(!ids.has(id))cache.delete(id);
 if(accepted&&ids.has(row.postId))cache.set(row.postId,signature);
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
 const evidence={scrollSeen:candidates.size,scrollNoRange:0,scrollHidden:0,scrollOffscreen:0,scrollUnbound:0,scrollRoot:0,scrollInner:0,scrollHit:hits,scrollAtEnd:0};
 const usable=[];
 for(const node of candidates){
  if(node.isConnected===false||node.ownerDocument&&node.ownerDocument!==doc){evidence.scrollUnbound++;continue;}
  if(node.scrollHeight-node.clientHeight<32||node.clientHeight<100){evidence.scrollNoRange++;continue;}
  const style=w.getComputedStyle?.(node);
  if(style&&/hidden|clip/.test(style.overflowY)){evidence.scrollHidden++;continue;}
  if(node===root&&(!style||style.overflowY==='visible')&&doc.body&&root!==doc.body&&/hidden|clip/.test(w.getComputedStyle?.(doc.body)?.overflowY||'')){evidence.scrollHidden++;continue;}
  if(node!==root){
   if(!style||!['auto','scroll','overlay'].includes(style.overflowY)||node.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]')){evidence.scrollHidden++;continue;}
   const rect=node.getBoundingClientRect();
   if(rect.width<250||rect.bottom<=0||rect.top>=w.innerHeight||rect.right<=0||rect.left>=w.innerWidth){evidence.scrollOffscreen++;continue;}
   if(!cards.some(c=>node.contains(c))){evidence.scrollUnbound++;continue;}
  }
  // Total scroll extent is not evidence that this node can still move down.
  const position=node===root?Math.max(Number(w.scrollY)||0,Number(node.scrollTop)||0):Number(node.scrollTop)||0;
  if(node.scrollHeight-node.clientHeight-position<=2){evidence.scrollAtEnd++;continue;}
  usable.push({node,count:cards.filter(c=>node===root||node.contains(c)).length});
 }
 usable.sort((a,b)=>b.count-a.count||(a.node===root?1:b.node===root?-1:0)||b.node.clientHeight-a.node.clientHeight);
 const selected=usable[0]?.node||null;
 if(selected)evidence[selected===root?'scrollRoot':'scrollInner']=1;
 if(stats)for(const k of Object.keys(evidence))stats[k]=Math.max(stats[k]||0,evidence[k]);
 return selected;
}
// A bound post below the actual viewport may sit behind a clipped ancestor even
// when the chosen inner feed has reached its end. Use only ordinary DOM scrolling.
function boundTail(w,core,group){
 const doc=w.document;
 const cards=Array.from(doc.querySelectorAll('[role="article"],article')).filter(c=>!c.parentElement?.closest('[role="article"],article'));
 if(cards.length>100)return null;
 for(const card of cards.slice().reverse()){
 if(!card||card.isConnected===false||card.ownerDocument!==doc||typeof card.scrollIntoView!=='function'||card.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]'))continue;
 const links=Array.from(card.querySelectorAll('a[href]')).filter(a=>a.closest('[role="article"],article')===card).slice(0,100).map(a=>core.parsePostLink(a.href)).filter(Boolean);
 if(!links.length||links.some(l=>l.sourceType!=='GROUP'||l.sourceId!==group)||new Set(links.map(l=>l.postId)).size!==1)continue;
 return card;
 }return null;
}
// overflow:hidden allows ordinary programmatic scrolling; overflow:clip does not.
// Only recover through ancestors of the exact last post, after normal selection
// and visible-tail alignment fail. Never change page styles or synthesize input.
function recoveryContainer(w,core,group){
 const card=boundTail(w,core,group);if(!card)return null;
 const doc=w.document,root=doc.scrollingElement,usable=[],ancestors=[];
 for(let node=card.parentElement,depth=0;node&&depth<32;node=node.parentElement,depth++)ancestors.push(node);
 if(root?.contains?.(card)&&!ancestors.includes(root))ancestors.push(root);
 for(const node of ancestors){
  if(node.isConnected===false||node.ownerDocument!==doc||node.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]'))continue;
  const style=w.getComputedStyle(node);
  const propagatedHidden=node===root&&style?.overflowY==='visible'&&doc.body&&w.getComputedStyle(doc.body)?.overflowY==='hidden';
  if(!style||!propagatedHidden&&!['hidden','auto','scroll','overlay'].includes(style.overflowY))continue;
  if(node.clientHeight<100||node.scrollHeight-node.clientHeight-(Number(node===root?w.scrollY:node.scrollTop)||0)<=2)continue;
  const rect=node.getBoundingClientRect();
  if(rect.width<250||node!==root&&(rect.bottom<=0||rect.top>=w.innerHeight||rect.right<=0||rect.left>=w.innerWidth))continue;
  usable.push(node);
 }
 // Move the outermost eligible ancestor, rather than another exhausted inner feed.
 return usable.at(-1)||null;
}
// 0.5.7 (40a236f) tail alignment, with the later fail-closed 100-card cap.
function baselineTailTarget(w,core,group){
 const doc=w.document;
 const cards=Array.from(doc.querySelectorAll('[role="article"],article')).filter(c=>!c.parentElement?.closest('[role="article"],article'));
 if(cards.length>100)return null;
 const card=cards.at(-1);
 if(!card||card.isConnected===false||card.ownerDocument!==doc||typeof card.scrollIntoView!=='function'||card.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]'))return null;
 const links=Array.from(card.querySelectorAll('a[href]')).filter(a=>a.closest('[role="article"],article')===card).slice(0,100).map(a=>core.parsePostLink(a.href)).filter(Boolean);
 if(!links.length||links.some(l=>l.sourceType!=='GROUP'||l.sourceId!==group)||new Set(links.map(l=>l.postId)).size!==1)return null;
 const rect=card.getBoundingClientRect();
 const vp=w.visualViewport,top=Number(vp?.offsetTop)||0,height=Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight);
 if(rect.width<250||rect.height<1||rect.bottom<=top+height-16||rect.left>=w.innerWidth||rect.right<=0)return null;
 return card;
}

function tailTarget(w,core,group){
 const card=boundTail(w,core,group);if(!card)return null;
 const rect=card.getBoundingClientRect();
 const vp=w.visualViewport,top=Number(vp?.offsetTop)||0,height=Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight);
 if(rect.width<250||rect.height<1||rect.bottom<=top+height+2||rect.left>=w.innerWidth||rect.right<=0)return null;
 return card;
}
function scrollTrace(w,card){
 const nodes=[];for(let n=card.parentElement,depth=0;n&&depth<32;depth++,n=n.parentElement)nodes.push([n,Number(n.scrollTop)||0]);
 const before=Number(w.scrollY)||0;
 return ()=>Number(w.scrollY)>before+1||nodes.some(([n,y])=>n.isConnected!==false&&(Number(n.scrollTop)||0)>y+1);
}
function ownMessageText(card){
 const selector='[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-ad-rendering-role="message"]';
 const texts=new Set(Array.from(card.querySelectorAll(selector)).filter(n=>n.closest('[role="article"],article')===card&&!n.closest('[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"]'))
  .map(n=>String(n.innerText||n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean));
 // Identical nested markers are one message. Distinct messages stay ambiguous.
 return texts.size===1?[...texts][0].slice(0,12000):'';
}
// CSS pixels; independent of whether a native wheel fallback was needed.
function viewportMetrics(w){
 const metric=v=>Number.isFinite(v)?Math.max(0,Math.min(10000,Math.round(v))):0,vp=w.visualViewport;
 return {viewportWidth:metric(w.innerWidth),viewportHeight:metric(w.innerHeight),visualWidth:metric(vp?.width??w.innerWidth),visualViewportHeight:metric(Math.min(w.innerHeight,vp?.height??w.innerHeight)),visualOffsetX:metric(vp?.offsetLeft??0),visualOffsetY:metric(vp?.offsetTop??0),visualScale100:metric((vp?.scale??1)*100)};
}
// Preserve viewport overlap, including a small surface after an IME/zoom change.
function scrollDistance(height,visibleHeight=height){const h=Number.isFinite(height)&&height>0?height:1,v=Number.isFinite(visibleHeight)&&visibleHeight>0?visibleHeight:h;return Math.max(1,Math.min(900,Math.round(Math.min(h,v)*.85)));}
function readDOM(w,model,core,group){
 Object.assign(model.stats,viewportMetrics(w));
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
  model.add({postId:ids[0],permalink:own[0].permalink,text,media:domPhotos(card,ids[0],group,core)},'DOM');
 }
}
async function run(w,m,core,fields,safe,send,setAbort,notify=()=>{},documentId=null){
 const empty=reason=>({status:'STOP',reason,rows:[],stats:zero()});
 if(m.consent!==true||!safe(m))return empty('CONTEXT');
 const baseline=m.baselineScroll===true;
 const fast=m.fastScroll===true&&m.gestureScroll!==true,maxSteps=fast?60:30,cadence=fast?500:1000;
 if((m.gestureScroll===true&&!baseline)||baseline&&(m.photosConsent===true||m.viewportConsent===true))return empty('CONTEXT');
 const selectTail=baseline?baselineTailTarget:tailTarget;
 const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
 const origin=w.performance.timeOrigin;
 const fresh=m.previousDocumentId!==undefined||m.previousTimeOrigin!==undefined?
  uuid.test(m.previousDocumentId||'')&&uuid.test(documentId||'')&&documentId!==m.previousDocumentId&&Number.isFinite(m.previousTimeOrigin)&&m.previousTimeOrigin>0&&Number.isFinite(origin)&&origin>=m.previousTimeOrigin:
  Number.isSafeInteger(m.documentAfter)&&Number.isFinite(origin)&&origin>m.documentAfter;
 if(!fresh)return {status:'WAIT_FRESH',reason:'FRESHNESS',rows:[],stats:zero()};
 const model=createModel(core,fields,m.groupId);let invalid=false,dispose=null,noticeDispose=null,gestureWatch=null;const end=w.performance.now()+Math.min(60000,Math.max(0,Number(m.remainingMs)||0));
 let wake;const cancelled=new Promise(r=>{wake=r;});
 const abort=()=>{if(invalid)return;invalid=true;model.clear();wake();notify({type:'desktopPreviewStop',nonce:m.nonce});void send({type:'stopDesktop',nonce:m.nonce}).catch(()=>{});};
 const pause=ms=>Promise.race([new Promise(r=>w.setTimeout(r,ms)),cancelled]);setAbort(abort);
 try{
  const info=await send({type:'desktopContext',nonce:m.nonce});if(!info?.active||info.nonce!==m.nonce||!safe(m))return empty('CONTEXT');
  dispose=w.FlipVisiblePosts.watch(w,m,abort);
  const ack=await send({type:'confirmDesktop',nonce:m.nonce,safe:true});if(!ack?.confirmed||invalid||!safe(m))return empty('CONTEXT');
  const active=async()=>{if(invalid||!safe(m)||w.FlipDesktopNotice?.inspect(w).blocked||w.performance.now()>=end)return false;const c=await send({type:'desktopContext',nonce:m.nonce});return !invalid&&safe(m)&&c?.active===true&&c.nonce===m.nonce;};
  if(!w.FlipDesktopNotice)return empty('ERROR');
  const notice=await w.FlipDesktopNotice.dismiss(w,{safe:()=>!invalid&&safe(m),pause,deadline:end-1500,onKnown:()=>notify({type:'desktopGestureHint',nonce:m.nonce,stage:'NOTICE'})});
  model.stats.noticeDetected=notice.detected;model.stats.noticeClosed=notice.closed;
  for(const [from,to] of [['reason','noticeReason'],['modals','noticeModals'],['visible','noticeVisible'],['source','noticeNameSource']])model.stats[to]=notice[from]||0;
  if(invalid||!safe(m)||notice.status==='CONTEXT')return empty('CONTEXT');
  if(notice.status==='BLOCKED')return {status:'STOP',reason:'NOTICE_BLOCKED',rows:[],stats:{...zero(),verified:1,desktop:Number(w.innerWidth>=900),noticeDetected:notice.detected,noticeReason:notice.reason||1,noticeModals:notice.modals||0,noticeVisible:notice.visible||0,noticeNameSource:notice.source||0}};
  noticeDispose=w.FlipDesktopNotice.watch?.(w,abort);if(invalid)return empty('CONTEXT');
  let gestureTarget=null;
  model.stats.gestureRequested=Number(m.gestureScroll===true);
  if(m.gestureScroll===true){
   if(!w.FlipDesktopGesture)return empty('ERROR');
   const began=w.performance.now();gestureWatch=w.FlipDesktopGesture.start(w,Math.min(15000,Math.max(0,end-began-1500)));
   notify({type:'desktopGestureHint',nonce:m.nonce,stage:'WAITING'});
   const picked=await Promise.race([gestureWatch.promise,cancelled]);
   if(invalid||!safe(m))return empty('CONTEXT');
   gestureTarget=picked?.target||null;if(gestureTarget)notify({type:'desktopGestureHint',nonce:m.nonce,stage:'ANCHORED'});model.stats.gestureWaitMs=Math.min(15000,Math.max(0,Math.floor(w.performance.now()-began)));
   for(const [from,to] of [['touches','gestureTouches'],['anchored','gestureAnchored'],['rejected','gestureRejected']])model.stats[to]=picked?.stats?.[from]||0;
  }
  // Reserve time for final extraction and native delivery within the original deadline.
  const scrollStart=w.performance.now(),scrollEnd=m.gestureScroll===true&&!gestureTarget?scrollStart:Math.min(scrollStart+30000,end-1500);
  let noTargetStreak=0,lastTailAt=-Infinity,nativeFailures=0,lastMoved=null;const photoSlots=new Map(),viewport=baseline?null:w.FlipDesktopViewport;let mediaBindings=[];const snapshots=new Map();
  model.stats.viewportModule=Number(!!viewport);
  model.stats.viewportGranted=Number(m.viewportConsent===true||m.photosConsent===true);
  if(viewport&&model.stats.viewportGranted){
   for(let attempt=0;attempt<3&&w.performance.now()<scrollEnd;attempt++){
    if(!await active())return empty('CONTEXT');
    const probe=await notify({type:'desktopViewportRequest',nonce:m.nonce,action:'probe'});
    if(invalid||!safe(m))return empty('CONTEXT');
    model.stats.viewportReady=Number(probe?.accepted===true&&probe.count===0);
    model.stats.viewportProbeCode=model.stats.viewportReady?0:probe?Math.min(3,Math.max(1,probe.count||1)):4;
    if(model.stats.viewportReady)break;
    await pause(200);
   }
  }
  model.stats.scrollFast=Number(fast);model.stats.scrollCadenceMs=cadence;
  for(let step=0;step<=maxSteps;step++){
   if(!await active())return empty('CONTEXT');
   model.stats.pageFocused=Math.max(model.stats.pageFocused,Number(w.document.hasFocus?.()===true));
   model.stats.pageVisible=Math.max(model.stats.pageVisible,Number(w.document.visibilityState==='visible'&&w.document.hidden!==true));
   readDOM(w,model,core,m.groupId);
   model.stats.viewportHeight=Math.min(10000,Math.round(w.innerHeight));model.stats.visualViewportHeight=Math.min(10000,Math.round(w.visualViewport?.height||w.innerHeight));
   model.stats.rootRemaining=Math.max(0,Math.min(10000,Math.round((w.document.scrollingElement?.scrollHeight||0)-(w.document.scrollingElement?.clientHeight||0)-(w.scrollY||0))));
   if(viewport&&m.photosConsent===true){
    // Private extension snapshot, never sent to Android or persisted. Does not finish transport.
    const snapshot=await send({type:'desktopSnapshot',nonce:m.nonce});
    if(invalid||!safe(m))return empty('CONTEXT');
    mediaBindings=snapshot?.status==='OK'&&Array.isArray(snapshot.media)?snapshot.media:[];model.stats.mediaBindingPosts=Math.max(model.stats.mediaBindingPosts,mediaBindings.filter(b=>b.ids?.length||b.urls?.length).length);
    for(const row of snapshot?.status==='OK'?snapshot.rows||[]:[])mergeSnapshot(model,snapshots,row);

    // A cold or still-changing first frame must not be lost by scrolling away.
    // One bounded retry, still inside the original capture/time budgets.
    for(let attempt=0;attempt<2&&model.stats.photoPreviewFrames<20&&w.performance.now()<scrollEnd-5000;attempt++){
     const shot=viewport.photos(w,core,m.groupId,photoNodes,photoSlots,new Set(model.rows().map(r=>r.postId)),mediaBindings,model.stats);if(!shot)break;
     model.stats.photoPreviewFrames++;const ack=await notify({type:'desktopViewportRequest',nonce:m.nonce,action:'photos',width:shot.width,height:shot.height,tiles:shot.tiles});
     if(invalid||!safe(m))return empty('CONTEXT');
     if(ack?.accepted===true&&ack.count===shot.tiles.length){model.stats.viewportReady=1;model.stats.viewportProbeCode=0;
      const latest=shot.network?await send({type:'desktopSnapshot',nonce:m.nonce}):null;
      const valid=shot.network?latest?.status==='OK'&&shot.valid(latest.media):shot.valid();
      const commit=await notify({type:'desktopViewportRequest',nonce:m.nonce,action:valid&&safe(m)?'commit':'drop',frameId:ack.requestId});
      if(invalid||!safe(m))return empty('CONTEXT');
      if(commit?.accepted===true&&commit.count===shot.tiles.length){for(const key of shot.keys)key.done=true;model.stats.photoPreviews+=commit.count;break;}
     }
     if(attempt===0){await pause(Math.min(150,Math.max(0,scrollEnd-w.performance.now())));if(invalid||!safe(m))return empty('CONTEXT');}
    }
   }
   if(step===maxSteps||w.performance.now()>=scrollEnd)break;
   let recovered=false,container;
   if(m.gestureScroll===true){
    if(!gestureWatch.valid(gestureTarget))return empty('CONTEXT');
    const root=gestureTarget===w.document.scrollingElement,pos=root?Math.max(w.scrollY||0,gestureTarget.scrollTop||0):gestureTarget.scrollTop||0;
    if(gestureTarget.scrollHeight-gestureTarget.clientHeight-pos<=2){model.stats.scrollAtEnd=Math.max(1,model.stats.scrollAtEnd);model.stats.scrollNoTarget++;await pause(Math.min(1000,Math.max(0,scrollEnd-w.performance.now())));continue;}
    container=gestureTarget;model.stats[root?'scrollRoot':'scrollInner']=1;
   }else container=scrollContainer(w,model.stats);
   // Retry a not-yet-scrollable feed within the same bounded window.
   if(!container){
    noTargetStreak++;
    const tail=noTargetStreak>=2&&model.stats.scrollTailAttempts<2&&w.performance.now()-lastTailAt>=5000?selectTail(w,core,m.groupId):null;
    if(tail){
     if(!await active()||selectTail(w,core,m.groupId)!==tail)return empty('CONTEXT');
     if(w.performance.now()>=scrollEnd)break;
     const moved=scrollTrace(w,tail);lastTailAt=w.performance.now();
     tail.scrollIntoView({block:'end',inline:'nearest',behavior:'instant'});
     model.stats.scrollTailAttempts++;model.stats.scrollSteps++;
     await pause(Math.min(1000,Math.max(0,scrollEnd-w.performance.now())));
     if(invalid||!safe(m))return empty('CONTEXT');
     if(moved()){model.stats.scrollMoves++;model.stats.scrollTailMoves++;}else model.stats.scrollStalls++;
     continue;
    }
    container=!baseline&&noTargetStreak>=2?recoveryContainer(w,core,m.groupId):null;
    if(!container){
     let point=viewport&&m.viewportConsent===true&&noTargetStreak>=2&&nativeFailures<3?viewport.point(w,core,m.groupId,lastMoved,model.stats):null;
     if(!point&&viewport&&m.viewportConsent===true&&noTargetStreak>=2&&nativeFailures<3)model.stats.pointMisses++;
     if(point){
      if(!await active())return empty('CONTEXT');point=viewport.point(w,core,m.groupId,lastMoved,model.stats);if(!point){model.stats.scrollNoTarget++;await pause(Math.min(1000,Math.max(0,scrollEnd-w.performance.now())));continue;}if(w.performance.now()>=scrollEnd)break;
      model.stats.nativeRequests++;const moved=viewport.trace(w),ack=await notify({type:'desktopViewportRequest',nonce:m.nonce,action:'scroll',...point});
      if(invalid||!safe(m))return empty('CONTEXT');
      if(ack?.accepted===true){model.stats.viewportReady=1;model.stats.viewportProbeCode=0;model.stats.scrollSteps++;model.stats.scrollNativeSteps++;await pause(Math.min(1000,Math.max(0,scrollEnd-w.performance.now())));
       if(invalid||!safe(m))return empty('CONTEXT');
       if(moved()){model.stats.scrollMoves++;model.stats.scrollNativeMoves++;nativeFailures=0;}else{model.stats.scrollStalls++;nativeFailures++;}continue;
      }if(ack)model.stats.nativeRejected++;else model.stats.nativeTimeout++;nativeFailures++;
     }
     model.stats.scrollNoTarget++;await pause(Math.min(1000,Math.max(0,scrollEnd-w.performance.now())));continue;
    }
    if(!await active()||recoveryContainer(w,core,m.groupId)!==container)return empty('CONTEXT');
    if(w.performance.now()>=scrollEnd)break;
    recovered=true;model.stats[container===w.document.scrollingElement?'scrollRoot':'scrollInner']=1;
   }
   if(!recovered)noTargetStreak=0;
   const root=container===w.document.scrollingElement;
   const readPosition=()=>root&&m.gestureScroll===true?Math.max(w.scrollY||0,container.scrollTop||0):root?w.scrollY:container.scrollTop;
   const before=readPosition();
   const top=scrollDistance(root?w.innerHeight:container.clientHeight,Math.min(w.innerHeight,w.visualViewport?.height||w.innerHeight));
   if(root)w.scrollBy({left:0,top,behavior:'instant'});else container.scrollBy({left:0,top,behavior:'instant'});
   model.stats.scrollSteps++;if(m.gestureScroll===true)model.stats.gestureScrollSteps++;
   await pause(Math.min(cadence,Math.max(0,scrollEnd-w.performance.now()))); // measure actual movement before the next bounded attempt
   if(readPosition()>before){model.stats.scrollMoves++;if(m.gestureScroll===true)model.stats.gestureScrollMoves++;lastMoved=container;}else model.stats.scrollStalls++;
  }
  model.stats.scrollElapsedMs=Math.min(30000,Math.max(0,Math.floor(w.performance.now()-scrollStart)));
  await pause(700);if(!await active())return empty('CONTEXT');readDOM(w,model,core,m.groupId);
  const result=await send({type:'readDesktop',nonce:m.nonce});if(invalid||!safe(m)||result?.status!=='OK')return empty('CONTEXT');
  for(const row of result.rows||[])mergeSnapshot(model,snapshots,row);
  for(const k of ['network','requests','bytes','verified','desktop','filtered','completed','streamErrors','decodeErrors','oversize','limitSkipped'])model.stats[k]=result.stats?.[k]||0;
  model.stats.desktop=w.innerWidth>=900?1:0;
  for(const k of statKeys)model.stats[k]=Math.max(0,Math.min(k==='bytes'?4194304:k==='scrollElapsedMs'?30000:k==='gestureWaitMs'?15000:10000,Math.floor(model.stats[k])));
  return {status:'OK',reason:'DONE',rows:model.rows(),stats:{...model.stats}};
 }catch{return empty('ERROR');}
 finally{noticeDispose?.();gestureWatch?.stop();setAbort(null);if(dispose)dispose();model.clear();void send({type:'stopDesktop',nonce:m.nonce}).catch(()=>{});}
}
const api={imageURL,photoAnchorHref,photoLinkId,cssPhotoSource,cssPhotoLoaded,opaquePhotoLink,photoSvgRoot,photoNodes,domPhotos,recoveryContainer,baselineTailTarget,tailTarget,scrollTrace,scrollContainer,ownMessageText,groupURL,exact,explicitIds,createModel,mergeSnapshot,viewportMetrics,scrollDistance,readDOM,run,statKeys,zero};if(typeof module!=='undefined')module.exports=api;root.FlipDesktopPreview=api;
})(globalThis);
