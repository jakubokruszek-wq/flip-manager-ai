/* Official native-view requests only. Media URLs stay inside the extension; no fetch, persistence or public bridge. */
(function(root){'use strict';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function transport(port,w){
 const pending=new Map();
 function clear(){for(const p of pending.values()){w.clearTimeout(p.timer);p.resolve(null);}pending.clear();}
 port.onDisconnect.addListener(clear);
 port.onMessage.addListener(m=>{
  if(m?.type!=='desktopViewportAck'||!uuid.test(m.requestId||''))return;
  const p=pending.get(m.requestId);if(!p||m.nonce!==p.nonce||Object.keys(m).sort().join(',')!=='accepted,count,nonce,requestId,type'||typeof m.accepted!=='boolean'||!Number.isInteger(m.count)||m.count<0||m.count>3)return;
  pending.delete(m.requestId);w.clearTimeout(p.timer);p.resolve(m);
 });
 return {clear,request(m){if(pending.size||!uuid.test(m.nonce||''))return Promise.resolve(null);
  const requestId=w.crypto.randomUUID();return new Promise(resolve=>{const timer=w.setTimeout(()=>{pending.delete(requestId);resolve(null);},m.action==='photos'?3500:1000);pending.set(requestId,{resolve,timer,nonce:m.nonce});try{port.postMessage({...m,requestId});}catch{clear();}});
 }};
}
function cards(w,core,group){
 const all=Array.from(w.document.querySelectorAll('[role="article"],article'));if(all.length>100)return[];
 return all.filter(c=>!c.parentElement?.closest('[role="article"],article')&&c.isConnected!==false&&c.ownerDocument===w.document&&!c.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"])')).flatMap(card=>{
  const links=Array.from(card.querySelectorAll('a[href]')).slice(0,100).filter(a=>a.closest('[role="article"],article')===card).map(a=>core.parsePostLink(a.href)).filter(Boolean);
  if(!links.length||links.some(p=>p.sourceType!=='GROUP'||p.sourceId!==group)||new Set(links.map(p=>p.postId)).size!==1)return[];
  return [{card,id:links[0].postId}];
 });
}
function scrollCards(w,core,group){
 const all=Array.from(w.document.querySelectorAll('[role="article"],article'));if(all.length>100)return[];
 return all.filter(card=>card.isConnected!==false&&card.ownerDocument===w.document&&!card.parentElement?.closest('[role="article"],article')&&!card.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"])')).filter(card=>
  !Array.from(card.querySelectorAll('a[href]')).slice(0,100).some(a=>{const p=core.parsePostLink(a.href);return p&&(p.sourceType!=='GROUP'||p.sourceId!==group);})).map(card=>({card}));
}
// A top ancestor hit proves delegated input only along the actual, unclipped
// parent path. Rectangles alone do not prove visibility through overflow clips.
function delegatedHit(w,node,hit,px,py){
 if(!hit||hit.ownerDocument!==w.document||hit.isConnected===false||!hit.contains?.(node)||w.getComputedStyle?.(node)?.pointerEvents!=='none'||node.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)return false;
 let p=node,depth=0;
 while(p&&p!==hit&&depth++<64){
  const style=w.getComputedStyle?.(p),r=p.getBoundingClientRect?.();
  if(style&&(style.display==='none'||/hidden|collapse/.test(style.visibility)||Number(style.opacity??1)<=0))return false;
  if(style&&r){if(/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)&&!(px>r.left&&px<r.right))return false;if(/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)&&!(py>r.top&&py<r.bottom))return false;}
  p=p.parentElement;
 }
 return p===hit;
}
function point(w,core,group,lastMoved=null,audit=null){
 const diag={pointProbes:0,pointEmpty:0,pointFrame:0,pointForeign:0,pointForm:0,pointDialog:0,pointComment:0,pointCommentable:0,pointChrome:0,pointUnbound:0,pointWidget:0,pointCache:Number(!!lastMoved),pointCacheCards:0,pointRects:0,viewportWidth:0,visualWidth:0,visualOffsetX:0,visualOffsetY:0,visualScale100:0};
 const finish=result=>{if(audit)Object.assign(audit,diag);return result;};
 const vp=w.visualViewport,width=Number(vp?.width)||w.innerWidth,height=Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight),left=Number(vp?.offsetLeft)||0,top=Number(vp?.offsetTop)||0;
 const metric=n=>Number.isFinite(n)?Math.max(0,Math.min(10000,Math.round(n))):0;
 Object.assign(diag,{viewportWidth:metric(w.innerWidth),visualWidth:metric(width),visualOffsetX:metric(left),visualOffsetY:metric(top),visualScale100:metric((Number(vp?.scale)||1)*100)});
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<100)return finish(null);
 // A wider grid must never reach behind an active modal.
 for(const modal of Array.from(w.document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[open]')).slice(0,20)){
  if(modal.matches?.('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[open]')!==true||modal.isConnected===false||modal.ownerDocument!==w.document)continue;
  const r=modal.getBoundingClientRect?.(),style=w.getComputedStyle?.(modal);
  if(r&&r.width>0&&r.height>0&&r.right>left&&r.bottom>top&&r.left<left+width&&r.top<top+height&&style?.display!=='none'&&style?.visibility!=='hidden'&&style?.visibility!=='collapse'&&Number(style?.opacity??1)>0&&modal.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false){diag.pointDialog++;return finish(null);}
 }
 const all=Array.from(w.document.querySelectorAll('[role="article"],article')).slice(0,100);
 const bound=scrollCards(w,core,group);
 const recent=lastMoved&&lastMoved.isConnected!==false&&lastMoved.ownerDocument===w.document&&!lastMoved.closest?.('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]')?
  all.filter(card=>card.ownerDocument===w.document&&card.isConnected!==false&&!card.parentElement?.closest('[role="article"],article')&&!card.closest('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"])')&&lastMoved.contains(card)).map(card=>({card})):[];
 diag.pointCacheCards=recent.length;
 const inputCards=[...bound,...recent],regions=[],probes=[];
 const clipped=r=>{if(!r)return null;const l=Math.max(left+width*.1,r.left),right=Math.min(left+width*.9,r.right),t=Math.max(top+height*.1,r.top),bottom=Math.min(top+height*.9,r.bottom);return right-l>=20&&bottom-t>=20?{left:l,right,top:t,bottom}:null;};
 const feedRect=recent.length?(lastMoved===w.document.scrollingElement?{left,top,right:left+width,bottom:top+height}:lastMoved.getBoundingClientRect?.()):null;
 if(feedRect){const r=clipped(feedRect);if(r)regions.push(r);}
 for(const {card} of inputCards.slice().reverse()){const r=clipped(card.getBoundingClientRect?.());if(r)regions.push(r);}
 // At most four visible regions plus a viewport grid: bounded, including safe margins.
 const sampleRegions=regions.slice(0,4);diag.pointRects=sampleRegions.length;
 for(const r of sampleRegions)probes.push([((r.left+r.right)/2-left)/width,((r.top+r.bottom)/2-top)/height]);
 probes.push([.5,.6],[.5,.4],[.35,.6],[.65,.6]);
 for(const r of sampleRegions)for(const x of [.1,.5,.9])for(const y of [.1,.5,.9])probes.push([(r.left+(r.right-r.left)*x-left)/width,(r.top+(r.bottom-r.top)*y-top)/height]);
 for(const y of [.12,.3,.5,.7,.88])for(const x of [.12,.3,.5,.7,.88])probes.push([x,y]);
 const nestedWidget=(n,region)=>{let p=n,depth=0;while(p&&p!==region&&depth++<64){const style=w.getComputedStyle?.(p);if(style&&/^(auto|scroll|overlay)$/.test(style.overflowY)&&p.scrollHeight-p.clientHeight>32&&!all.some(c=>p.contains(c)))return true;p=p.parentElement;}return false;};
 // A native hit can be an ordinary parent of pointer-events:none post content.
 // Bind that TOP hit by real ancestry and a visible card rectangle, never by
 // coordinates alone, an underlying layer or a guessed post identity.
 const ancestorCard=(hit,px,py)=>bound.find(({card})=>{
  if(hit.isConnected===false||typeof hit.contains!=='function'||!hit.contains(card)||card.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)return false;
  const style=w.getComputedStyle?.(card),r=card.getBoundingClientRect?.();
  if(style&&(style.display==='none'||/hidden|collapse/.test(style.visibility)||Number(style.opacity??1)<=0))return false;
  if(!r||r.width<20||r.height<20||px<r.left||px>r.right||py<r.top||py>r.bottom)return false;
  // Do not use a shared parent containing a known foreign-group post.
  return delegatedHit(w,card,hit,px,py)&&!all.some(c=>hit.contains(c)&&!bound.some(b=>b.card===c));
 })?.card;
 const recentHit=(n,px,py)=>{
  if(!recent.length||!feedRect||!lastMoved.contains(n)||px<feedRect.left||px>feedRect.right||py<feedRect.top||py>feedRect.bottom)return false;
  let p=n,depth=0;while(p&&p!==lastMoved&&depth++<64)p=p.parentElement;return p===lastMoved;
 };
 const visited=new Set();
 for(const [x,y] of probes){
  const key=Math.round(x*10000)+':'+Math.round(y*10000);if(visited.has(key))continue;if(visited.size>=64)break;visited.add(key);diag.pointProbes++;
  const px=left+width*x,py=top+height*y,n=w.document.elementFromPoint?.(px,py);
  if(!n){diag.pointEmpty++;continue;}
  if(n.ownerDocument!==w.document){diag.pointForeign++;continue;}
  if(/^(IFRAME|FRAME)$/.test(n.tagName||'')){diag.pointFrame++;continue;}
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName||'')){diag.pointForm++;continue;}
  if(n.closest('[role="dialog"],[role="alertdialog"]')){diag.pointDialog++;continue;}
  const comment=n.closest('[role="comment"],[data-testid*="comment"]');
  if(comment){diag.pointComment++;if(/commentable/i.test(comment.getAttribute?.('data-testid')||''))diag.pointCommentable++;continue;}
  if(n.closest('[role="menu"],[role="listbox"],[role="complementary"],aside,nav,header')){diag.pointChrome++;continue;}
  const card=inputCards.find(p=>p.card.contains(n))?.card;
  const region=card||(recentHit(n,px,py)?lastMoved:null)||n.closest('[role="feed"],[data-pagelet*="Feed"],main,[role="main"]')||(ancestorCard(n,px,py)?n:null);
  if(!region){diag.pointUnbound++;continue;}
  if(nestedWidget(n,region)){diag.pointWidget++;continue;}
  return finish({x,y});
 }
 return finish(null);
}
function trace(w){
 const vp=w.visualViewport,positions=[];
 for(const card of Array.from(w.document.querySelectorAll('[role="article"],article')).slice(0,100))if(card.isConnected!==false&&typeof card.getBoundingClientRect==='function')positions.push([card,card.getBoundingClientRect().top]);
 const sy=Number(w.scrollY)||0,vy=Number(vp?.offsetTop)||0;
 return ()=>Number(w.scrollY)>sy+1||Number(w.visualViewport?.offsetTop)>vy+1||positions.some(([c,y])=>c.isConnected!==false&&c.getBoundingClientRect().top<y-1);
}
function mediaOwners(bindings,allowedIds){
 const ids=new Map(),urls=new Map();
 if(!Array.isArray(bindings)||bindings.length>20)return {ids,urls};
 const add=(map,key,post)=>{if(map.has(key)&&map.get(key)!==post)map.set(key,null);else if(!map.has(key))map.set(key,post);};
 for(const b of bindings){if(!/^\d{5,30}$/.test(b?.postId||''))continue;
  for(const id of Array.isArray(b.ids)?b.ids.slice(0,20):[])if(typeof id==='string'&&/^\d{5,30}$/.test(id))add(ids,id,b.postId);
  for(const url of Array.isArray(b.urls)?b.urls.slice(0,20):[])if(typeof url==='string'&&url.length<=2100)add(urls,url,b.postId);
 }
 return {ids,urls};
}
// A rendered IMG outside semantic articles can still belong to a retained post.
// Its owner must come from an unambiguous attachment ID/URL in the network snapshot.
function mediaOwner(item,lookup){
 const byId=item.mediaId&&lookup.ids.has(item.mediaId)?lookup.ids.get(item.mediaId):undefined;
 const byUrl=item.url&&lookup.urls.has(item.url)?lookup.urls.get(item.url):undefined;
 if(byId===null||byUrl===null||(byId&&byUrl&&byId!==byUrl))return null;
 const owner=byId||byUrl||null;return item.linkedPostId&&item.linkedPostId!==owner?null:owner;
}
function documentImages(w,core,group,helpers,owners,allowedIds,audit){
 if(!helpers?.imageURL||!helpers.photoAnchorHref||(!owners.ids.size&&!owners.urls.size))return[];
 const count=k=>{if(audit)audit[k]=Math.min(10000,(audit[k]||0)+1);},doc=w.document,result=[];
 const forbidden='[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],form,input,textarea,[contenteditable="true"],video,[role="menu"],[role="listbox"],[role="complementary"],aside,nav,header';
 const images=doc.querySelectorAll('img');
 for(let index=0;index<Math.min(500,images.length);index++){const node=images[index];
  count('photoDocumentNodes');
  if(node.tagName!=='IMG'||node.ownerDocument!==doc||node.isConnected===false||node.closest('[role="article"],article')||node.closest(forbidden))continue;
  const region=node.closest('[role="feed"],[data-pagelet*="Feed"],main,[role="main"]');if(!region)continue;
  const anchor=node.closest('a[href]'),href=helpers.photoAnchorHref(anchor),mediaId=helpers.photoLinkId(href);
  let linkedPostId=null;
  if(anchor&&!mediaId){const p=core.parsePostLink(href);
   if(p){if(p.sourceType!=='GROUP'||p.sourceId!==group)continue;linkedPostId=p.postId;}
   else if(!helpers.opaquePhotoLink(href))continue;
  }
  const source=()=>node.currentSrc||node.src||node.getAttribute?.('src');const raw=source();
  if(typeof raw!=='string'||raw.length>8192)continue;
  const url=helpers.imageURL(raw);
  if(!url&&!(mediaId&&/^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(raw)))continue;
  const item={url,mediaId,linkedPostId,networkRequired:true},id=mediaOwner(item,owners);
  if(!id||!allowedIds.has(id)){count('photoIdentityRejected');continue;}
  const unit=node.closest('[data-pagelet*="FeedUnit"],[data-testid="post_container"]');
  const ownUnit=()=>{if(!unit)return true;const nodes=unit.querySelectorAll('a[href]');if(nodes.length>100)return false;const links=Array.from(nodes);return !links.map(a=>core.parsePostLink(helpers.photoAnchorHref(a))).filter(Boolean).some(p=>p.sourceType!=='GROUP'||p.sourceId!==group||p.postId!==id);};
  if(!ownUnit())continue;
  const rect=node.getBoundingClientRect();if(rect.width<200||rect.height<100){count('photoSizeRejected');continue;}
  const ready=()=>node.isConnected!==false&&node.ownerDocument===doc&&!node.closest('[role="article"],article')&&!node.closest(forbidden)&&node.closest('[role="feed"],[data-pagelet*="Feed"],main,[role="main"]')===region&&node.closest('[data-pagelet*="FeedUnit"],[data-testid="post_container"]')===unit&&node.closest('a[href]')===anchor&&helpers.photoAnchorHref(anchor)===href&&ownUnit()&&node.complete===true&&node.naturalWidth>0;
  count('photoDocumentBound');result.push({node,item,source,ready,container:region,id});
 }
 return result;
}
function photos(w,core,group,photoNodes,slots,allowedIds,bindings=[],audit=null,helpers=null,preferredIds=null){
 const count=k=>{if(audit)audit[k]=Math.min(10000,(audit[k]||0)+1);};
 if(!allowedIds||typeof allowedIds.has!=='function')return null;
 const vp=w.visualViewport,width=Number(vp?.width)||w.innerWidth,height=Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight),left=Number(vp?.offsetLeft)||0,top=Number(vp?.offsetTop)||0;
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<100||width>10000||height>10000)return null;
 const tiles=[],keys=[],checks=[];let network=false;
 const owners=mediaOwners(bindings,allowedIds);
 const identity=mediaOwner;
 const exactCards=cards(w,core,group),targets=exactCards.map(p=>({...p,network:false}));
 for(const {card} of scrollCards(w,core,group)){
  if(exactCards.some(p=>p.card===card))continue;
  // Media identity comes from an exact parsed network record, never text, order or an image ID guessed as a post ID.
  const sources=photoNodes(card,null,group,core,audit),ids=new Set(sources.map(p=>identity(p.item,owners)).filter(Boolean));
  if(ids.size!==1){if(sources.length)count('photoIdentityRejected');continue;}const id=[...ids][0];targets.push({card,id,network:true});
 }

 for(const p of documentImages(w,core,group,helpers,owners,allowedIds,audit))targets.push({card:p.container,id:p.id,network:true,documentSource:p});
 const result=()=>({width,height,tiles,keys,network,valid:(currentBindings=bindings)=>Math.abs((Number(w.visualViewport?.width)||w.innerWidth)-width)<1&&Math.abs(Math.min(w.innerHeight,Number(w.visualViewport?.height)||w.innerHeight)-height)<1&&Math.abs((Number(w.visualViewport?.offsetLeft)||0)-left)<1&&Math.abs((Number(w.visualViewport?.offsetTop)||0)-top)<1&&checks.every(check=>check(mediaOwners(currentBindings,allowedIds)))});
 // A new unresolved post gets a frame before extra photos of a captured post.
 const captured=id=>[...(slots.get(id)?.values()||[])].some(mark=>mark.done);
 if(preferredIds)targets.sort((a,b)=>Number(captured(a.id))-Number(captured(b.id))||Number(preferredIds.has(b.id))-Number(preferredIds.has(a.id)));
 for(const {card,id,network:fromNetwork,documentSource} of targets){
  if(preferredIds&&tiles.some(tile=>tile.postId===id))continue;
  if(!allowedIds.has(id))continue;
  if(!documentSource)count(fromNetwork?'photoNetworkCards':'photoExactCards');
  if(!slots.has(id)){if(slots.size===20)continue;slots.set(id,new Map());}const media=slots.get(id);
  for(const {node,item,source:readSource,ready} of documentSource?[documentSource]:photoNodes(card,id,group,core,audit)){
   count('photoSources');
   if((fromNetwork||item.networkRequired)&&identity(item,owners)!==id){count('photoIdentityRejected');continue;}
   if(node.tagName==='IMG'&&(node.complete!==true||node.naturalWidth<1)){count('photoUnready');continue;}
   const needsNetwork=fromNetwork||item.networkRequired;
   const key=item.mediaId||item.url;if(!key)continue;
   if(media.get(key)?.done||keys.includes(media.get(key))){count('photoAlreadyDone');continue;}
   const r=node.getBoundingClientRect(),x=Math.max(0,r.left-left),y=Math.max(0,r.top-top),right=Math.min(width,r.right-left),bottom=Math.min(height,r.bottom-top);
   if(right-x<60||bottom-y<60||(right-x)*(bottom-y)<r.width*r.height*.6){count('photoGeometryRejected');continue;}
   // Occluding headers/dialogs must never become a thumbnail of a post image.
   const points=[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([px,py])=>[left+x+(right-x)*px,top+y+(bottom-y)*py]);
   const uncovered=()=>points.every(([px,py])=>{
    const hit=w.document.elementFromPoint?.(px,py);
    if(hit===node||node.contains?.(hit))return true;
    // Rendered images may deliberately delegate input to their real parent.
    // Accept only the actual top hit, not a sibling overlay or another document.
    if(!delegatedHit(w,node,hit,px,py))return false;
    if(hit.closest?.('[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[role="menu"],[role="listbox"],[role="complementary"],aside,nav,header'))return false;
    return true;
   });
   if(!uncovered()){count('photoOccluded');continue;}
   // Offscreen/occluded images must not consume the three visible-preview slots.
   if(!media.has(key)){if(media.size===3)continue;media.set(key,{slot:media.size,done:false});}const mark=media.get(key);
   const sourceValue=()=>readSource?readSource():node.currentSrc||node.getAttribute?.('href')||node.getAttribute?.('src');const source=sourceValue();
   checks.push(lookup=>{const after=node.getBoundingClientRect();return node.isConnected!==false&&node.ownerDocument===w.document&&(documentSource?identity(item,lookup)===id:needsNetwork?scrollCards(w,core,group).some(p=>p.card===card)&&identity(photoNodes(card,id,group,core).find(p=>p.node===node)?.item||{},lookup)===id:cards(w,core,group).some(p=>p.card===card&&p.id===id))&&["left","top","right","bottom"].every(k=>Math.abs(after[k]-r[k])<1)&&source===sourceValue()&&(!ready||ready())&&uncovered();});
   count('photoSelected');if(documentSource)count('photoDocumentSelected');network=network||needsNetwork;tiles.push({postId:id,slot:mark.slot,x,y,width:right-x,height:bottom-y});keys.push(mark);
   if(tiles.length===3)return result();
   if(preferredIds)break;
  }
 }
 return tiles.length?result():null;
}
const api={transport,cards,point,trace,photos};if(typeof module!=='undefined')module.exports=api;root.FlipDesktopViewport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
