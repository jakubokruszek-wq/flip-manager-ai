/* One rendered photo of one exact opened post. No fetch, URL export, storage or whole-page capture retention. */
(function(root){'use strict';
const excluded='[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],[data-testid*="shared"],[data-ad-rendering-role*="shared"],blockquote,form,input,textarea,[contenteditable="true"],video';
// Match immutable CDN asset paths, never post IDs inferred from media IDs.
// Unknown/query-driven endpoints keep byte-exact matching only.
function photoURL(raw){try{const u=new URL(raw);return typeof raw==='string'&&raw.length<=8192&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&/(?:^|\.)fbcdn\.net$/i.test(u.hostname)?u:null;}catch{return null;}}
function photoAssetKey(raw){
 const u=photoURL(raw);if(!u||!/^scontent(?:-[a-z0-9-]+)?(?:\.[a-z0-9-]+)*\.fbcdn\.net$/i.test(u.hostname))return null;
 if(!/^\/v\/t[0-9.]+-\d+\/\d{5,30}_\d{5,30}_[A-Za-z0-9_-]{1,180}\.(?:jpe?g|png|webp|avif)$/i.test(u.pathname))return null;
 // GeckoView isolated worlds may not expose URLSearchParams iterators. Decode
 // names from the bounded URL query; malformed escapes and duplicates fail closed.
 let keys;try{keys=u.search?u.search.slice(1).split('&').map(p=>decodeURIComponent(p.split('=',1)[0].replace(/\+/g,' '))):[];}catch{return null;}
 if(new Set(keys).size!==keys.length||keys.some(k=>! /^(?:_nc_[a-z0-9_]+|oh|oe|stp|efg|ccb|edm)$/i.test(k)))return null;
 return u.pathname;
}
function photoMatch(raw,known){
 if(!photoURL(raw)||!photoURL(known))return 0;
 if(raw===known)return 1;
 const key=photoAssetKey(raw);return key&&key===photoAssetKey(known)?2:0;
}
function create(){const used=new Set();return {async read(w,m,core,preview,exact,request){
 const details={documentImg:0,rawImg:0,rawSvg:0,rawCss:0,sourceProof:0,ownerAccepted:0,ownerRejected:0,sizeRejected:0,qualified:0,sourceExact:0,sourceAsset:0,sourceMiss:0,noArticle:0,foreignOwner:0,anchorOwner:0,excludedOwner:0,sourceOwner:0};
 const result=(status,count=0,reason=status==='STOP'?'CONTEXT':count===1?'CAPTURED':'NO_IMAGE')=>{const filters=root.FlipReviewPost.ownPhotoFilters(w,m);return{status,count,reason,details:{...details},...(filters?{filters}:{})};};
 const safe=()=>m.consent===true&&m.ocrConsent===true&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.nonce||'')&&w.location.href===m.expectedUrl&&exact(w.location.href,m.groupId,m.postId,m.fixture===true)&&['interactive','complete'].includes(w.document.readyState)&&w.document.visibilityState==='visible'&&!w.document.hidden&&w.document.hasFocus?.()===true&&!/log in|logowanie|captcha|checkpoint|security check/i.test(w.document.title||'')&&!w.document.querySelector('input[type="password"],form[action*="login"],form[action*="checkpoint"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"],[role="alertdialog"]');
 if(!safe()||used.has(m.nonce))return result('STOP');used.add(m.nonce);while(used.size>32)used.delete(used.values().next().value);
 details.documentImg=Math.min(500,w.document.querySelectorAll('img').length);
 const cards=root.FlipReviewPost.cards(w,m,core,preview);
 if(cards.length>1)return result('OK',0,'AMBIGUOUS');const card=cards[0]||null;let region=card;
 const sources=()=>root.FlipReviewPost.ownPhotoSources(w,m);details.sourceProof=Math.min(20,sources().length);
 // IMG, single-image SVG and leaf CSS share the same rendered crop path.
 // Non-IMG candidates additionally require exact structured-photo source proof
 // and an already completed page resource; never request another image resource.
 const rendered=new Map();
 const source=n=>rendered.has(n)?rendered.get(n).source():n.currentSrc||n.src||'';
 const topology=n=>!rendered.has(n)||rendered.get(n).valid();
 const loaded=n=>rendered.has(n)?topology(n)&&preview.cssPhotoLoaded(n,source(n)):n.complete&&n.naturalWidth>=200&&n.naturalHeight>=120;
 const bump=k=>{details[k]=Math.min(700,details[k]+1);};
 const sourceMatch=(raw,audit=false)=>{let kind=0;for(const known of sources()){const value=photoMatch(raw,known);if(value===1){kind=1;break;}if(value===2)kind=2;}if(audit)bump(kind===1?'sourceExact':kind===2?'sourceAsset':'sourceMiss');return kind>0;};
 const anchorScopes=new Map();
 const ownAnchorScope=n=>{
  const a=n.closest('a[href]');if(!a)return null;
  let u;try{u=new URL(preview.photoAnchorHref(a)||'',w.location.href);}catch{return null;}
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)||u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id'))return null;
  const direct=exact(u.href,m.groupId,m.postId,false);
  // pcb is the explicit enclosing post on this photo link; fbid remains media-only.
  const album=/^\/photo(?:\.php)?\/?$/i.test(u.pathname)&&u.searchParams.getAll('set').length===1&&u.searchParams.get('set')==='pcb.'+m.postId&&u.searchParams.getAll('fbid').length===1&&/^\d{5,30}$/.test(u.searchParams.get('fbid')||'')&&!u.searchParams.has('story_fbid');
  if(!direct&&!album)return null;
  const scope=n.closest('main,[role="main"]')||n.closest('[role="dialog"]');
  if(!scope||scope.ownerDocument!==w.document||scope.isConnected===false||!scope.contains(n)||scope.closest(excluded))return null;
  let p=n.parentElement,depth=0;while(p&&p!==scope&&depth++<32){if(/comment|komentarz|reply|odpowiedź/i.test(p.getAttribute?.('aria-label')||''))return null;p=p.parentElement;}
  if(p!==scope)return null;return scope;
 };
 // Exact own-Story URI is positive media ownership even when Facebook uses
 // plain DIV/role=link without article or href. Crop IMG only, in one visible
 // document region, and reject any identifiable conflicting local owner.
 const ownSourceScope=(n,audit=false)=>{
  if(n.tagName!=='IMG'||!sources().includes(source(n)))return null;
  const blockedRegion=excluded+',aside,nav,header,footer,[role="complementary"],[role="menu"],[role="listbox"]';
  const visible=r=>r.ownerDocument===w.document&&r.isConnected!==false&&!r.closest(blockedRegion)&&r.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;
  const dialog=n.closest('[role="dialog"]'),main=n.closest('main,[role="main"]');
  let scope=dialog||main;
  const roots=Array.from(w.document.querySelectorAll(scope?(dialog?'[role="dialog"]':'main,[role="main"]'):'main,[role="main"],[role="dialog"]'));
  if(roots.length>20)return null;const active=roots.filter(visible);
  if(scope){if(active.length!==1||active[0]!==scope)return null;}
  else{if(active.length||!w.document.body)return null;scope=w.document.body;}
  if(!visible(scope)||!scope.contains(n)||n.closest(blockedRegion))return null;
  const conflict=a=>{
   let u;try{u=new URL(preview.photoAnchorHref(a)||'',w.location.href);}catch{return true;}
   const encloses=a===n||a.contains?.(n);
   // Comment/fragment links elsewhere in the region are not owner evidence.
   if(u.hash||u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id'))return !!encloses;
   const p=core.parsePostLink(u.href);
   if(p&&(p.sourceType!=='GROUP'||p.sourceId!==m.groupId||p.postId!==m.postId))return true;
   if(!encloses)return false;
   if(u.protocol!=='https:'||u.username||u.password||u.port||!['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))return true;
   if(/^\/photo(?:\.php)?\/?$/i.test(u.pathname)){
    const sets=u.searchParams.getAll('set'),media=u.searchParams.getAll('fbid');
    if(sets.length>1||sets.length===1&&sets[0]!=='pcb.'+m.postId||media.length>1||media.length===1&&!/^\d{5,30}$/.test(media[0])||u.searchParams.has('story_fbid'))return true;
   }
   return false;
  };
  let p=n,depth=0;
  while(p&&depth++<32){
   if(p.ownerDocument!==w.document||p.isConnected===false)return null;
   if(/comment|komentarz|reply|odpowiedź|suggest|recommend|polecan|proponowan/i.test(p.getAttribute?.('aria-label')||'')){if(audit)bump('excludedOwner');return null;}
   for(const attr of ['data-post-id','data-story-id']){const id=p.getAttribute?.(attr);if(id&&/^\d{5,30}$/.test(id)&&id!==m.postId){if(audit)bump('foreignOwner');return null;}}
   if(p.tagName==='A'&&p.hasAttribute?.('href')&&conflict(p)){if(audit)bump('foreignOwner');return null;}
   if(p===scope)break;p=p.parentElement;
  }
  if(p!==scope)return null;
  const anchors=Array.from(scope.querySelectorAll('a[href]'));if(anchors.length>200)return null;
  for(const a of anchors){
   if(a.closest(blockedRegion)||a.closest('[role="article"],article')||a.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)continue;
   const d=a.closest('[role="dialog"]');if(d&&d!==dialog)continue;
   if(conflict(a)){if(audit)bump('foreignOwner');return null;}
  }
  return scope;
 };
 const proofOwn=(n,audit=false)=>{
  if(!sourceMatch(source(n),audit))return false;
  let parent=n.closest('[role="article"],article'),depth=0;
  if(!parent){if(audit)bump('noArticle');let scope=ownAnchorScope(n);if(scope){anchorScopes.set(n,scope);if(audit)bump('anchorOwner');return true;}scope=ownSourceScope(n,audit);if(!scope)return false;anchorScopes.set(n,scope);if(audit)bump('sourceOwner');return true;}
  while(parent&&depth++<20){
   if(parent.closest(excluded)||/comment|komentarz|reply|odpowiedź/i.test(parent.getAttribute?.('aria-label')||'')){if(audit)bump('excludedOwner');return false;}
   const anchors=Array.from(parent.querySelectorAll('a[href]'));if(anchors.length>200){if(audit)bump('foreignOwner');return false;}
   for(const a of anchors){const p=core.parsePostLink(a.href);if(p&&(p.sourceType!=='GROUP'||p.sourceId!==m.groupId||p.postId!==m.postId)){if(audit)bump('foreignOwner');return false;}}
   parent=parent.parentElement?.closest('[role="article"],article');
  }
  if(parent&&audit)bump('foreignOwner');return !parent;
 };
 if(!card&&!sources().length)return result('OK',0,root.FlipReviewPost.ownPhotoStatus(w,m));
 const zone=card?.closest('[role="dialog"]')||card?.closest('main,[role="main"]');
 if(zone&&root.FlipReviewPost.cardId(card,core,preview,m.groupId,w.location.href)===m.postId){const links=Array.from(zone.querySelectorAll('a[href]'));const articles=Array.from(zone.querySelectorAll('[role="article"],article'));if(links.length<=200&&articles.length===1&&articles[0]===card){const posts=links.map(n=>core.parsePostLink(n.href)).filter(Boolean);if(posts.length&&posts.every(p=>p.sourceType==='GROUP'&&p.sourceId===m.groupId&&p.postId===m.postId))region=zone;}}

 const own=(n,audit=false)=>{
  if(!safe()||!topology(n)||n.ownerDocument!==w.document||n.isConnected===false||n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)return false;
  if(n.closest(excluded)){if(audit)bump('excludedOwner');return false;}
  const dom=card&&card.isConnected!==false&&root.FlipReviewPost.cards(w,m,core,preview).includes(card)&&(n.closest('[role="article"],article')===card||region!==card&&!n.closest('[role="article"],article'))&&region.contains(n);
  if(dom){if(audit)sourceMatch(source(n),true);return true;}return proofOwn(n,audit);
 };
 const scope=region||w.document,limit=region?100:500;
 const pool=Array.from(scope.querySelectorAll('img')).slice(0,limit);details.rawImg=pool.length;
 for(const n of Array.from(scope.querySelectorAll('svg image')).slice(0,100)){
  details.rawSvg++;const svg=preview.photoSvgRoot(n);if(!svg||rendered.has(svg))continue;
  const info={source:()=>preview.photoAnchorHref(n)||'',valid:()=>n.isConnected!==false&&n.ownerDocument===w.document&&preview.photoSvgRoot(n)===svg&&!n.closest(excluded)&&sourceMatch(preview.photoAnchorHref(n))};
  rendered.set(svg,info);if(info.valid())pool.push(svg);
 }
 for(const n of Array.from(scope.querySelectorAll('[style*="background"],[role="img"]')).slice(0,100)){
  details.rawCss++;if(pool.includes(n)||rendered.has(n))continue;
  const info={source:()=>preview.cssPhotoSource(n)||'',valid:()=>sourceMatch(preview.cssPhotoSource(n))};
  rendered.set(n,info);if(info.valid())pool.push(n);
 }
 const images=pool.filter(n=>{const accepted=!!own(n,true);details[accepted?"ownerAccepted":"ownerRejected"]++;return accepted;}).filter(n=>{const r=n.getBoundingClientRect();const accepted=r.width>=120&&r.height>=100;if(!accepted)details.sizeRejected++;return accepted;});details.qualified=images.length;
 // Reused own photo in multiple unbound cards is ambiguous; never choose the first card.
 if(!images.length)return result('OK',0,'NO_IMAGE');
 if(!card&&new Set(images.map(n=>n.closest('[role="article"],article')||anchorScopes.get(n))).size!==1)return result('OK',0,'AMBIGUOUS');
 // One image per post gives every unresolved post a chance within the shared 20-image limit.
 // Alt text is only a local ranking hint, never evidence of fields or identity.
 images.sort((a,b)=>Number(/text|napis|tekst|mieszkan|sprzed|cena/i.test(b.alt||''))-Number(/text|napis|tekst|mieszkan|sprzed|cena/i.test(a.alt||''))||((b.naturalWidth||b.getBoundingClientRect().width)*(b.naturalHeight||b.getBoundingClientRect().height))-((a.naturalWidth||a.getBoundingClientRect().width)*(a.naturalHeight||a.getBoundingClientRect().height)));
 let lastReason='NO_IMAGE';
 for(const image of images.slice(0,3)){
  if(!own(image))return result('STOP');image.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await new Promise(r=>w.setTimeout(r,250));if(!own(image))return result('STOP');
  for(let attempt=0;attempt<3&&!loaded(image);attempt++){await new Promise(r=>w.setTimeout(r,250));if(!own(image))return result('STOP');}
  if(!loaded(image)){lastReason='UNLOADED';continue;}
  const box=()=>{const v=w.visualViewport,left=Number(v?.offsetLeft)||0,top=Number(v?.offsetTop)||0,width=Number(v?.width)||w.innerWidth,height=Number(v?.height)||w.innerHeight,r=image.getBoundingClientRect();const x=Math.max(left,r.left),y=Math.max(top,r.top),right=Math.min(left+width,r.right),bottom=Math.min(top+height,r.bottom);return {x:x-left,y:y-top,width:right-x,height:bottom-y,vw:width,vh:height,ox:left,oy:top};};
  const tile=box(),capturedSource=source(image);if(tile.width<120||tile.height<100){lastReason='OCCLUDED';continue;}
  const hit=()=>{if(!loaded(image)||source(image)!==capturedSource)return false;const b=box();for(const k of ['x','y','width','height','vw','vh','ox','oy'])if(Math.abs(b[k]-tile[k])>1)return false;for(const [x,y] of [[.2,.2],[.5,.5],[.8,.8]]){const h=w.document.elementFromPoint(tile.ox+tile.x+tile.width*x,tile.oy+tile.y+tile.height*y);if(h!==image&&!image.contains(h)&&!(h?.contains?.(image)&&w.getComputedStyle(image).pointerEvents==='none'))return false;}return own(image);};
  if(!hit()){lastReason='OCCLUDED';continue;}
  const ack=await request({type:'desktopViewportRequest',nonce:m.nonce,action:'photos',width:tile.vw,height:tile.vh,tiles:[{postId:m.postId,slot:0,x:tile.x,y:tile.y,width:tile.width,height:tile.height}]});
  if(!ack?.accepted)return safe()?result('OK',0,'NO_ACK'):result('STOP');
  const valid=hit();const commit=await request({type:'desktopViewportRequest',nonce:m.nonce,action:valid?'commit':'drop',frameId:ack.requestId});
  if(!safe()||!valid)return result('STOP');return commit?.accepted&&commit.count===1?result('OK',1):result('STOP');
 }
 return result('OK',0,lastReason);
}};}
const api={create,photoAssetKey,photoMatch};if(typeof module!=='undefined')module.exports=api;root.FlipReviewImages=api;
})(globalThis);
