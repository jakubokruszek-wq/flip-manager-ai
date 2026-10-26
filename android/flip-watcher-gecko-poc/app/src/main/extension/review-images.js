/* One rendered photo of one exact opened post. No fetch, URL export, storage or whole-page capture retention. */
(function(root){'use strict';
const excluded='[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],[data-testid*="shared"],[data-ad-rendering-role*="shared"],blockquote,form,input,textarea,[contenteditable="true"],video';
function create(){const used=new Set();return {async read(w,m,core,preview,exact,request){
 const result=(status,count=0)=>({status,count});
 const safe=()=>m.consent===true&&m.ocrConsent===true&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.nonce||'')&&w.location.href===m.expectedUrl&&exact(w.location.href,m.groupId,m.postId,m.fixture===true)&&['interactive','complete'].includes(w.document.readyState)&&w.document.visibilityState==='visible'&&!w.document.hidden&&w.document.hasFocus?.()===true&&!/log in|logowanie|captcha|checkpoint|security check/i.test(w.document.title||'')&&!w.document.querySelector('input[type="password"],form[action*="login"],form[action*="checkpoint"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"],[role="alertdialog"]');
 if(!safe()||used.has(m.nonce))return result('STOP');used.add(m.nonce);while(used.size>32)used.delete(used.values().next().value);
 const cards=root.FlipReviewPost.cards(w,m,core,preview);
 if(cards.length!==1)return result('OK');const card=cards[0];let region=card;
 const zone=card.closest('[role="dialog"]')||card.closest('main,[role="main"]');
 if(zone){const links=Array.from(zone.querySelectorAll('a[href]'));const articles=Array.from(zone.querySelectorAll('[role="article"],article'));if(links.length<=200&&articles.length===1&&articles[0]===card){const posts=links.map(n=>core.parsePostLink(n.href)).filter(Boolean);if(posts.length&&posts.every(p=>p.sourceType==='GROUP'&&p.sourceId===m.groupId&&p.postId===m.postId))region=zone;}}

 const own=n=>safe()&&card.isConnected!==false&&preview.ownCardId(card,core,m.groupId)===m.postId&&n.ownerDocument===w.document&&n.isConnected!==false&&(n.closest('[role="article"],article')===card||region!==card&&!n.closest('[role="article"],article'))&&region.contains(n)&&!n.closest(excluded)&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;
 const images=Array.from(region.querySelectorAll('img')).slice(0,100).filter(n=>own(n)&&n.complete&&n.naturalWidth>=200&&n.naturalHeight>=120).filter(n=>{const r=n.getBoundingClientRect();return r.width>=120&&r.height>=100;});
 // One image per post gives every unresolved post a chance within the shared 20-image limit.
 // Alt text is only a local ranking hint, never evidence of fields or identity.
 images.sort((a,b)=>Number(/text|napis|tekst|mieszkan|sprzed|cena/i.test(b.alt||''))-Number(/text|napis|tekst|mieszkan|sprzed|cena/i.test(a.alt||''))||b.naturalWidth*b.naturalHeight-a.naturalWidth*a.naturalHeight);
 for(const image of images.slice(0,3)){
  if(!own(image))return result('STOP');image.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await new Promise(r=>w.setTimeout(r,250));if(!own(image))return result('STOP');
  const box=()=>{const v=w.visualViewport,left=Number(v?.offsetLeft)||0,top=Number(v?.offsetTop)||0,width=Number(v?.width)||w.innerWidth,height=Number(v?.height)||w.innerHeight,r=image.getBoundingClientRect();const x=Math.max(left,r.left),y=Math.max(top,r.top),right=Math.min(left+width,r.right),bottom=Math.min(top+height,r.bottom);return {x:x-left,y:y-top,width:right-x,height:bottom-y,vw:width,vh:height,ox:left,oy:top};};
  const tile=box();if(tile.width<120||tile.height<100)continue;
  const hit=()=>{const b=box();for(const k of ['x','y','width','height','vw','vh','ox','oy'])if(Math.abs(b[k]-tile[k])>1)return false;for(const [x,y] of [[.2,.2],[.5,.5],[.8,.8]]){const h=w.document.elementFromPoint(tile.ox+tile.x+tile.width*x,tile.oy+tile.y+tile.height*y);if(h!==image&&!image.contains(h)&&!(h?.contains?.(image)&&w.getComputedStyle(image).pointerEvents==='none'))return false;}return own(image);};
  if(!hit())continue;
  const ack=await request({type:'desktopViewportRequest',nonce:m.nonce,action:'photos',width:tile.vw,height:tile.vh,tiles:[{postId:m.postId,slot:0,x:tile.x,y:tile.y,width:tile.width,height:tile.height}]});
  if(!ack?.accepted)return result(safe()?'OK':'STOP');
  const valid=hit();const commit=await request({type:'desktopViewportRequest',nonce:m.nonce,action:valid?'commit':'drop',frameId:ack.requestId});
  if(!safe()||!valid)return result('STOP');return result(commit?.accepted?'OK':'STOP',commit?.accepted?commit.count:0);
 }
 return result('OK');
}};}
const api={create};if(typeof module!=='undefined')module.exports=api;root.FlipReviewImages=api;
})(globalThis);
