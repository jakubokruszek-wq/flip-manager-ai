/* One rendered photo of one exact opened post. No fetch, URL export, storage or whole-page capture retention. */
(function(root){'use strict';
const excluded='[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],[data-testid*="shared"],[data-ad-rendering-role*="shared"],blockquote,form,input,textarea,[contenteditable="true"],video';
function create(){const used=new Set();return {async read(w,m,core,preview,exact,request){
 const result=(status,count=0,reason=status==='STOP'?'CONTEXT':count===1?'CAPTURED':'NO_IMAGE')=>{const filters=root.FlipReviewPost.ownPhotoFilters(w,m);return{status,count,reason,...(filters?{filters}:{})};};
 const safe=()=>m.consent===true&&m.ocrConsent===true&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.nonce||'')&&w.location.href===m.expectedUrl&&exact(w.location.href,m.groupId,m.postId,m.fixture===true)&&['interactive','complete'].includes(w.document.readyState)&&w.document.visibilityState==='visible'&&!w.document.hidden&&w.document.hasFocus?.()===true&&!/log in|logowanie|captcha|checkpoint|security check/i.test(w.document.title||'')&&!w.document.querySelector('input[type="password"],form[action*="login"],form[action*="checkpoint"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"],[role="alertdialog"]');
 if(!safe()||used.has(m.nonce))return result('STOP');used.add(m.nonce);while(used.size>32)used.delete(used.values().next().value);
 const cards=root.FlipReviewPost.cards(w,m,core,preview);
 if(cards.length>1)return result('OK',0,'AMBIGUOUS');const card=cards[0]||null;let region=card;
 const sources=()=>root.FlipReviewPost.ownPhotoSources(w,m);
 // IMG, single-image SVG and leaf CSS share the same rendered crop path.
 // Non-IMG candidates additionally require exact structured-photo source proof
 // and an already completed page resource; never request another image resource.
 const rendered=new Map();
 const source=n=>rendered.has(n)?rendered.get(n).source():n.currentSrc||n.src||'';
 const topology=n=>!rendered.has(n)||rendered.get(n).valid();
 const loaded=n=>rendered.has(n)?topology(n)&&preview.cssPhotoLoaded(n,source(n)):n.complete&&n.naturalWidth>=200&&n.naturalHeight>=120;
 const proofOwn=n=>{
  if(!sources().includes(source(n)))return false;
  let parent=n.closest('[role="article"],article'),depth=0;if(!parent)return false;
  while(parent&&depth++<20){
   if(parent.closest(excluded)||/comment|komentarz|reply|odpowiedź/i.test(parent.getAttribute?.('aria-label')||''))return false;
   const anchors=Array.from(parent.querySelectorAll('a[href]'));if(anchors.length>200)return false;
   for(const a of anchors){const p=core.parsePostLink(a.href);if(p&&(p.sourceType!=='GROUP'||p.sourceId!==m.groupId||p.postId!==m.postId))return false;}
   parent=parent.parentElement?.closest('[role="article"],article');
  }
  return !parent;
 };
 if(!card&&!sources().length)return result('OK',0,root.FlipReviewPost.ownPhotoStatus(w,m));
 const zone=card?.closest('[role="dialog"]')||card?.closest('main,[role="main"]');
 if(zone&&root.FlipReviewPost.cardId(card,core,preview,m.groupId,w.location.href)===m.postId){const links=Array.from(zone.querySelectorAll('a[href]'));const articles=Array.from(zone.querySelectorAll('[role="article"],article'));if(links.length<=200&&articles.length===1&&articles[0]===card){const posts=links.map(n=>core.parsePostLink(n.href)).filter(Boolean);if(posts.length&&posts.every(p=>p.sourceType==='GROUP'&&p.sourceId===m.groupId&&p.postId===m.postId))region=zone;}}

 const own=n=>safe()&&topology(n)&&n.ownerDocument===w.document&&n.isConnected!==false&&!n.closest(excluded)&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false&&(
  card&&card.isConnected!==false&&root.FlipReviewPost.cards(w,m,core,preview).includes(card)&&(n.closest('[role="article"],article')===card||region!==card&&!n.closest('[role="article"],article'))&&region.contains(n)||proofOwn(n));
 const scope=region||w.document,limit=region?100:500;
 const pool=Array.from(scope.querySelectorAll('img')).slice(0,limit);
 for(const n of Array.from(scope.querySelectorAll('svg image')).slice(0,100)){
  const svg=preview.photoSvgRoot(n);if(!svg||rendered.has(svg))continue;
  const info={source:()=>preview.photoAnchorHref(n)||'',valid:()=>n.isConnected!==false&&n.ownerDocument===w.document&&preview.photoSvgRoot(n)===svg&&!n.closest(excluded)&&sources().includes(preview.photoAnchorHref(n))};
  rendered.set(svg,info);if(info.valid())pool.push(svg);
 }
 for(const n of Array.from(scope.querySelectorAll('[style*="background"],[role="img"]')).slice(0,100)){
  if(pool.includes(n)||rendered.has(n))continue;
  const info={source:()=>preview.cssPhotoSource(n)||'',valid:()=>sources().includes(preview.cssPhotoSource(n))};
  rendered.set(n,info);if(info.valid())pool.push(n);
 }
 const images=pool.filter(n=>own(n)).filter(n=>{const r=n.getBoundingClientRect();return r.width>=120&&r.height>=100;});
 // Reused own photo in multiple unbound cards is ambiguous; never choose the first card.
 if(!images.length)return result('OK',0,'NO_IMAGE');
 if(!card&&new Set(images.map(n=>n.closest('[role="article"],article'))).size!==1)return result('OK',0,'AMBIGUOUS');
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
const api={create};if(typeof module!=='undefined')module.exports=api;root.FlipReviewImages=api;
})(globalThis);
