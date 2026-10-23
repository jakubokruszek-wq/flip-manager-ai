/* Official native-view requests only. No media URLs, fetch, persistence or public bridge. */
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
 return all.filter(c=>!c.parentElement?.closest('[role="article"],article')&&c.isConnected!==false&&c.ownerDocument===w.document&&!c.closest('[role="dialog"],[role="comment"],[data-testid*="comment"]')).flatMap(card=>{
  const links=Array.from(card.querySelectorAll('a[href]')).slice(0,100).filter(a=>a.closest('[role="article"],article')===card).map(a=>core.parsePostLink(a.href)).filter(Boolean);
  if(!links.length||links.some(p=>p.sourceType!=='GROUP'||p.sourceId!==group)||new Set(links.map(p=>p.postId)).size!==1)return[];
  return [{card,id:links[0].postId}];
 });
}
function scrollCards(w,core,group){
 const all=Array.from(w.document.querySelectorAll('[role="article"],article'));if(all.length>100)return[];
 return all.filter(card=>card.isConnected!==false&&card.ownerDocument===w.document&&!card.parentElement?.closest('[role="article"],article')&&!card.closest('[role="dialog"],[role="comment"],[data-testid*="comment"]')).filter(card=>
  !Array.from(card.querySelectorAll('a[href]')).slice(0,100).some(a=>{const p=core.parsePostLink(a.href);return p&&(p.sourceType!=='GROUP'||p.sourceId!==group);})).map(card=>({card}));
}
function point(w,core,group,lastMoved=null){
 // Wheel is navigation input, not post identity evidence. Exact anchors are not required.
 const bound=scrollCards(w,core,group);
 // Input can return to the same feed that demonstrably moved in THIS trial,
 // even when outbound/cross-post links exclude its cards from identity matching.
 const recent=lastMoved&&lastMoved.isConnected!==false&&lastMoved.ownerDocument===w.document&&!lastMoved.closest?.('[role="dialog"],[role="comment"],[data-testid*="comment"]')?
  Array.from(w.document.querySelectorAll('[role="article"],article')).slice(0,100).filter(card=>card.ownerDocument===w.document&&card.isConnected!==false&&!card.parentElement?.closest('[role="article"],article')&&!card.closest('[role="dialog"],[role="comment"],[data-testid*="comment"]')&&lastMoved.contains(card)).map(card=>({card})):[];
 const inputCards=[...bound,...recent];
 const vp=w.visualViewport,width=Number(vp?.width)||w.innerWidth,height=Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight),left=Number(vp?.offsetLeft)||0,top=Number(vp?.offsetTop)||0;
 const probes=[];
 const feedRect=recent.length?(lastMoved===w.document.scrollingElement?{left,top,right:left+width,bottom:top+height}:lastMoved.getBoundingClientRect?.()):null;
 if(feedRect){const l=Math.max(left+width*.1,feedRect.left),r=Math.min(left+width*.9,feedRect.right),t=Math.max(top+height*.1,feedRect.top),b=Math.min(top+height*.9,feedRect.bottom);
  if(r-l>=100&&b-t>=100)probes.push([((l+r)/2-left)/width,((t+b)/2-top)/height]);}
 const recentHit=(n,px,py)=>{
  if(!recent.length||!feedRect||!lastMoved.contains(n)||px<feedRect.left||px>feedRect.right||py<feedRect.top||py>feedRect.bottom)return false;
  // Do not retarget a nested menu/dropdown/overflow widget inside the feed.
  let p=n,depth=0;
  while(p&&p!==lastMoved&&depth++<64){
   if(p.closest?.('[role="menu"],[role="listbox"],[role="complementary"]'))return false;
   const style=w.getComputedStyle?.(p);
   if(style&&/^(auto|scroll|overlay)$/.test(style.overflowY)&&p.scrollHeight-p.clientHeight>32&&!recent.some(c=>p.contains(c.card)))return false;
   p=p.parentElement;
  }
  return p===lastMoved;
 };
 for(const {card} of inputCards.slice().reverse()){
  const r=card.getBoundingClientRect?.();if(!r)continue;
  const l=Math.max(left+width*.1,r.left),right=Math.min(left+width*.9,r.right),t=Math.max(top+height*.1,r.top),bottom=Math.min(top+height*.9,r.bottom);
  if(right-l>=20&&bottom-t>=20)probes.push([((l+right)/2-left)/width,((t+bottom)/2-top)/height]);
 }
 probes.push([.5,.6],[.5,.4],[.35,.6],[.65,.6]);
 for(const [x,y] of probes){
  const px=left+width*x,py=top+height*y,n=w.document.elementFromPoint?.(px,py);
  if(!n||n.ownerDocument!==w.document||/^(IFRAME|FRAME|INPUT|TEXTAREA|SELECT)$/.test(n.tagName||'')||n.closest('[role="dialog"],[role="comment"],[data-testid*="comment"],[role="menu"],[role="listbox"],[role="complementary"],aside,nav,header'))continue;
  // Hit must belong to a rendered group card or semantic feed/main; never an arbitrary sidebar widget.
  if(inputCards.some(p=>p.card.contains(n))||recentHit(n,px,py)||n.closest('[role="feed"],[data-pagelet*="Feed"],main,[role="main"]'))return {x,y};
 }
 return null;
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
function photos(w,core,group,photoNodes,slots,allowedIds,bindings=[]){
 if(!allowedIds||typeof allowedIds.has!=='function')return null;
 const vp=w.visualViewport,width=Number(vp?.width)||w.innerWidth,height=Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight),left=Number(vp?.offsetLeft)||0,top=Number(vp?.offsetTop)||0;
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<100||width>10000||height>10000)return null;
 const tiles=[],keys=[],checks=[];let network=false;
 const owners=mediaOwners(bindings,allowedIds);
 const identity=(item,lookup)=>{
  const byId=item.mediaId&&lookup.ids.has(item.mediaId)?lookup.ids.get(item.mediaId):undefined;
  const byUrl=item.url&&lookup.urls.has(item.url)?lookup.urls.get(item.url):undefined;
  if(byId===null||byUrl===null||(byId&&byUrl&&byId!==byUrl))return null;
  return byId||byUrl||null;
 };
 const exactCards=cards(w,core,group),targets=exactCards.map(p=>({...p,network:false}));
 for(const {card} of scrollCards(w,core,group)){
  if(exactCards.some(p=>p.card===card))continue;
  // Media identity comes from an exact parsed network record, never text, order or an image ID guessed as a post ID.
  const sources=photoNodes(card,'00000',group,core),ids=new Set(sources.map(p=>identity(p.item,owners)).filter(Boolean));
  if(ids.size!==1)continue;const id=[...ids][0];targets.push({card,id,network:true});
 }

 const result=()=>({width,height,tiles,keys,network,valid:(currentBindings=bindings)=>Math.abs((Number(w.visualViewport?.width)||w.innerWidth)-width)<1&&Math.abs(Math.min(w.innerHeight,Number(w.visualViewport?.height)||w.innerHeight)-height)<1&&Math.abs((Number(w.visualViewport?.offsetLeft)||0)-left)<1&&Math.abs((Number(w.visualViewport?.offsetTop)||0)-top)<1&&checks.every(check=>check(mediaOwners(currentBindings,allowedIds)))});
 for(const {card,id,network:fromNetwork} of targets){
  if(!allowedIds.has(id))continue;
  if(!slots.has(id)){if(slots.size===20)continue;slots.set(id,new Map());}const media=slots.get(id);
  for(const {node,item} of photoNodes(card,id,group,core)){
   if(fromNetwork&&identity(item,owners)!==id)continue;
   if(node.tagName==='IMG'&&(node.complete!==true||node.naturalWidth<1))continue;
   const key=item.mediaId||item.url;if(!key)continue;
   if(media.get(key)?.done)continue;
   const r=node.getBoundingClientRect(),x=Math.max(0,r.left-left),y=Math.max(0,r.top-top),right=Math.min(width,r.right-left),bottom=Math.min(height,r.bottom-top);
   if(right-x<60||bottom-y<60||(right-x)*(bottom-y)<r.width*r.height*.6)continue;
   // Occluding headers/dialogs must never become a thumbnail of a post image.
   const points=[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([px,py])=>[left+x+(right-x)*px,top+y+(bottom-y)*py]);
   const uncovered=()=>points.every(([px,py])=>{const hit=w.document.elementFromPoint?.(px,py);return hit===node||node.contains?.(hit)});
   if(!uncovered())continue;
   // Offscreen/occluded images must not consume the three visible-preview slots.
   if(!media.has(key)){if(media.size===3)continue;media.set(key,{slot:media.size,done:false});}const mark=media.get(key);
   const source=node.currentSrc||node.getAttribute?.('href')||node.getAttribute?.('src');
   checks.push(lookup=>{const after=node.getBoundingClientRect();return node.isConnected!==false&&node.ownerDocument===w.document&&(fromNetwork?scrollCards(w,core,group).some(p=>p.card===card)&&identity(photoNodes(card,id,group,core).find(p=>p.node===node)?.item||{},lookup)===id:cards(w,core,group).some(p=>p.card===card&&p.id===id))&&["left","top","right","bottom"].every(k=>Math.abs(after[k]-r[k])<1)&&source===(node.currentSrc||node.getAttribute?.('href')||node.getAttribute?.('src'))&&uncovered();});
   network=network||fromNetwork;tiles.push({postId:id,slot:mark.slot,x,y,width:right-x,height:bottom-y});keys.push(mark);
   if(tiles.length===3)return result();
  }
 }
 return tiles.length?result():null;
}
const api={transport,cards,point,trace,photos};if(typeof module!=='undefined')module.exports=api;root.FlipDesktopViewport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
