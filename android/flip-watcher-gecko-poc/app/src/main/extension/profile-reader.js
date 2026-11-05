/* Paired PROFILE sources only. No network client, response reader, storage or page bridge. */
(function(root){'use strict';
const hosts=new Set(['facebook.com','www.facebook.com','m.facebook.com']);
const postId=v=>typeof v==='string'&&/^(?:\d{5,30}|pfbid[A-Za-z0-9]{10,180})$/.test(v);
const sourceId=v=>typeof v==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(v);
const forbidden='[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],[data-ad-rendering-role*="shared"],[data-testid*="shared"],blockquote,form,input,textarea,video,[contenteditable="true"]';
const article='[role="article"],article',unit='[data-pagelet^="FeedUnit_"],[data-testid="post_container"]';
function url(raw,fixture=false){try{const u=new URL(raw);return !u.username&&!u.password&&!u.hash&&(!u.port&&u.protocol==='https:'&&hosts.has(u.hostname)||fixture&&u.protocol==='http:'&&u.hostname==='127.0.0.1')?u:null;}catch{return null;}}
function profilePath(u,id){return u.pathname.replace(/\/$/,'')==='/'+id||u.pathname==='/profile.php'&&u.searchParams.get('id')===id||u.pathname.split('/').filter(Boolean).length===3&&u.pathname.split('/')[1]==='people'&&u.pathname.replace(/\/$/,'').split('/')[3]===id;}
function identity(w,id,fixture=false){
 if(!sourceId(id))return null;const current=url(w.location.href,fixture);if(!current)return null;
 if(fixture&&current.hostname!=='127.0.0.1')return null;
 const aliases=new Set([id]),proofs=new Set();let canonical=null;
 const explicit=u=>u.pathname==='/profile.php'?u.searchParams.get('id'):u.pathname.match(/^\/people\/[^/]+\/(\d{5,30})\/?$/)?.[1]||u.pathname.match(/^\/(\d{5,30})\/?$/)?.[1];
 const currentOwner=explicit(current);if(currentOwner&&currentOwner!==id)return null;
 for(const n of Array.from(w.document.head?.querySelectorAll('meta[property],link[rel="canonical"]')||[]).slice(0,120)){
  const key=n.getAttribute('property')||n.getAttribute('rel'),value=n.getAttribute('content')||n.getAttribute('href')||'';
  if(['al:android:url','al:ios:url'].includes(key)){const m=/^fb:\/\/(?:profile|page)\/(\d{5,30})\/?$/.exec(value);if(m)proofs.add(m[1]);}
  if(key==='fb:profile_id'&&/^\d{5,30}$/.test(value))proofs.add(value);
  if(key==='canonical'||key==='og:url'){const u=url(value,fixture);if(u){const owner=explicit(u);if(owner)proofs.add(owner);if(profilePath(u,id))proofs.add(id);if(key==='canonical'||!canonical)canonical=u;}}
 }
 if(/^\d+$/.test(id)){if(!proofs.has(id)||[...proofs].some(p=>p!==id))return null;}
 else if(!canonical||!profilePath(canonical,id))return null;
 if(!canonical||(!profilePath(canonical,id)&&!/^\/[A-Za-z0-9_.-]{1,100}\/?$/.test(canonical.pathname)))return null;
 const path=current.pathname.replace(/\/$/,'');if(!profilePath(current,id)&&!/^\/[A-Za-z0-9_.-]{1,100}$/.test(path))return null;
 if(/^\/[A-Za-z0-9_.-]{1,100}$/.test(path)&&path!=='/profile.php')aliases.add(path.slice(1));
 const canonicalAlias=canonical.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/?$/)?.[1];if(canonicalAlias&&canonicalAlias!=='profile.php')aliases.add(canonicalAlias);
 return {id,aliases,href:current.href};
}
function link(raw,proof){const u=url(raw);if(!u||u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id'))return null;
 const m=/^\/([^/]+)\/posts\/([^/]+)\/?$/.exec(u.pathname);
 if(m&&proof.aliases.has(m[1])&&postId(m[2]))return m[2];
 const people=/^\/people\/[^/]+\/(\d{5,30})\/posts\/([^/]+)\/?$/.exec(u.pathname);if(people&&people[1]===proof.id&&postId(people[2]))return people[2];
 if(['/story.php','/permalink.php'].includes(u.pathname)&&u.searchParams.get('id')===proof.id&&postId(u.searchParams.get('story_fbid')))return u.searchParams.get('story_fbid');
 return null;
}
function onePost(card,proof){const nodes=card.querySelectorAll('a[href]');if(nodes.length>100)return null;const ids=[];
 for(const n of nodes){if(n.closest?.(forbidden))continue;const candidate=url(n.href);if(candidate&&(candidate.searchParams.has('comment_id')||candidate.searchParams.has('reply_comment_id')))continue;const id=link(n.href,proof);if(id)ids.push(id);else{const u=url(n.href);if(u&&(/\/(posts|permalink)\//.test(u.pathname)||u.searchParams.has('story_fbid')))return null;}}
 return ids.length&&new Set(ids).size===1?ids[0]:null;
}
function cards(w,proof){
 const units=Array.from(w.document.querySelectorAll(unit));const articles=Array.from(w.document.querySelectorAll(article));if(units.length>100||articles.length>100)return [];
 return [...units.filter(n=>!n.parentElement?.closest(unit)),...articles.filter(n=>!n.parentElement?.closest(article+','+unit))].filter(n=>n.isConnected!==false&&!n.closest(forbidden)).map(card=>({card,id:onePost(card,proof)})).filter(p=>p.id);
}
function messages(card,preview){const nodes=card.querySelectorAll(preview.messageSelector);if(nodes.length>30)return [];
 return Array.from(nodes).filter(n=>!n.closest(forbidden)&&!Array.from(nodes).some(p=>p!==n&&p.contains(n)));
}
function ownText(card,preview){const values=[...new Set(messages(card,preview).map(n=>preview.ownMessageNodeText(n,card)).filter(Boolean))];return values.length===1?values[0]:'';}
function row(id,owner,text,fields,preview){const f=preview.posterSaleFields(preview.negotiableSaleFields(fields.previewFields({postText:text}),text),text);
 return {postId:id,permalink:`https://www.facebook.com/${owner}/posts/${id}/`,layer:'DOM',price:f.price,priceSource:f.priceSource,area:f.area,rooms:f.rooms,district:f.district,neighborhood:f.neighborhood,street:f.street,intent:f.intent,usable:f.usable===true,photos:0,qualification:f.qualification};}
function photoNodes(card,preview,fixture=false){
 const nodes=Array.from(card.querySelectorAll('img')).slice(0,100).filter(n=>!n.closest(forbidden)&&n.complete===true&&n.naturalWidth>=60&&n.naturalHeight>=60&&(preview.imageURL(n.currentSrc||n.src)||fixture&&/^data:image\//.test(n.currentSrc||n.src))&&n.getBoundingClientRect().width>=200&&n.getBoundingClientRect().height>=100).map(node=>({node,source:()=>node.currentSrc||node.src,owned:()=>card.contains(node)}));
 for(const n of messages(card,preview)){
  for(let node=n,depth=0;node&&card.contains(node)&&depth<5;node=node.parentElement,depth++){
   const s=node.ownerDocument.defaultView.getComputedStyle(node),r=node.getBoundingClientRect();
   if(!node.closest(forbidden)&&(s.backgroundImage&&s.backgroundImage!=='none'||s.backgroundColor&&!['transparent','rgba(0, 0, 0, 0)'].includes(s.backgroundColor))&&r.width>=200&&r.height>=120&&(node.innerText||'').trim()===(n.innerText||'').trim()&&(n.innerText||'').trim().length>=25){nodes.push({node,source:()=>node.innerText,owned:()=>card.contains(node)});break;}
  }
 }
 return nodes;
}
function viewport(w){const vp=w.visualViewport;return {width:Number(vp?.width)||w.innerWidth,height:Math.min(w.innerHeight,Number(vp?.height)||w.innerHeight),left:Number(vp?.offsetLeft)||0,top:Number(vp?.offsetTop)||0};}
async function capturePhoto(request,payload,stable,pause,alive){
 for(let attempt=0;attempt<2;attempt++){
  if(attempt)await pause(150);
  if(!alive()||!stable())return false;
  const frame=await request(payload);
  if(frame?.accepted!==true)continue;
  const valid=alive()&&stable();
  const commit=await request({action:valid?'commit':'drop',frameId:frame.requestId});
  if(valid&&commit?.accepted===true&&commit.count===1)return true;
 }
 return false;
}
async function run(w,m,fields,preview,send){
 const stats=preview.zero(),rows=new Map(),texts=new Map(),captured=new Set(),structured=new Map(),scripts=new WeakMap();let textBytes=0;
 const stop=reason=>({sourceId:m.sourceId,status:'STOP',reason,rows:[],postTexts:[],stats});
 if(m.consent!==true||!sourceId(m.sourceId)||!/^[-a-f0-9]{36}$/.test(m.nonce||''))return stop('PROFILE_CONTEXT_REJECTED');
 const proof=identity(w,m.sourceId,m.fixture===true),origin=w.performance.timeOrigin;if(!proof)return stop('PROFILE_IDENTITY_NOT_CONFIRMED');
 const live=()=>w.performance.timeOrigin===origin&&w.location.href===proof.href&&identity(w,m.sourceId,m.fixture===true)!==null;
 const request=value=>send({type:'desktopViewportRequest',nonce:m.nonce,...value});
 const initial=await request({action:'probe'});if(!live()||initial?.accepted!==true)return stop('PROFILE_VIEWPORT_NOT_READY');
 stats.verified=1;stats.desktop=1;stats.viewportModule=1;stats.viewportGranted=1;stats.viewportReady=1;stats.textExpandArmed=0;stats.scrollFast=1;stats.scrollCadenceMs=750;
 const start=w.performance.now(),end=start+45000;
 for(let step=0;step<60&&w.performance.now()<end&&rows.size<50;step++){
  if(!live())return stop('PROFILE_CONTEXT_REJECTED');
  const modal=Array.from(w.document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).some(n=>n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0);if(modal)return stop('PROFILE_MODAL_BLOCKED');
  stats.pageVisible=Math.max(stats.pageVisible,Number(w.document.visibilityState==='visible'&&!w.document.hidden));stats.pageFocused=Math.max(stats.pageFocused,Number(w.document.hasFocus()));
  let bytes=0;
  for(const node of Array.from(w.document.querySelectorAll('script:not([src])')).slice(0,120)){
   const text=node.textContent||'';if(!text||text.length>524288||bytes+text.length>2097152)continue;bytes+=text.length;
   if(scripts.get(node)===text)continue;scripts.set(node,text);
   for(const r of root.FlipFacebookCollectorCore.extractStructuredRecordsFromText(text,{sourceType:'PROFILE',sourceId:m.sourceId,sourceUrl:'https://www.facebook.com/'+m.sourceId+'/'}).slice(0,100)){
    if(structured.size>=50&&!structured.has(r.postId))break;
    if(r.sourceType==='PROFILE'&&r.sourceId===m.sourceId&&r.permalink===`https://www.facebook.com/${m.sourceId}/posts/${r.postId}/`)structured.set(r.postId,r);
   }
  }
  Object.assign(stats,preview.viewportMetrics(w));
  const selected=cards(w,proof);stats.articles=Math.max(stats.articles,selected.length);
  for(const {card,id}of selected){
   if(!live())return stop('PROFILE_CONTEXT_REJECTED');
   const text=ownText(card,preview);stats.textCardsBound++;stats.textMessageNodes+=messages(card,preview).length;
   let numeric=id;try{const ft=JSON.parse(card.getAttribute('data-ft')||'{}');if(String(ft.content_owner_id_new)===m.sourceId&&/^\d{5,30}$/.test(String(ft.top_level_post_id)))numeric=String(ft.top_level_post_id);}catch{}
   const record=structured.get(numeric),structuredText=record?.rootTextVerified===true&&record?.identityConfidence==='EXACT'?String(record.text||''):'';
   const r=row(id,m.sourceId,text||structuredText,fields,preview);if(!text&&structuredText){r.layer='HYDRATION';stats.hydration++;}if(rows.size<50||rows.has(id)){
    const old=rows.get(id);if(!old||text.length>(texts.get(id)?.length||0))rows.set(id,r);stats.dom++;
    if(text&&!texts.has(id)&&textBytes+text.length<=64000){texts.set(id,text.slice(0,12000));textBytes+=text.length;}
   }
   if(captured.has(id)||!rows.has(id))continue;
   const candidates=photoNodes(card,preview,m.fixture===true);
   const media=new Set((record?.media||[]).filter(p=>p.exactAssociation===true&&p.exactPostId===numeric).map(p=>preview.imageURL(p.url)).filter(Boolean));
   if(media.size){for(const node of Array.from(w.document.images||[]).slice(0,500)){
    const key=preview.imageURL(node.currentSrc||node.src);
    if(key&&media.has(key)&&node.complete&&node.naturalWidth>=60&&node.naturalHeight>=60&&!node.closest(forbidden)&&!candidates.some(p=>p.node===node))candidates.push({node,source:()=>node.currentSrc||node.src,owned:()=>media.has(preview.imageURL(node.currentSrc||node.src))});
   }}
   for(const p of candidates){
    const n=p.node,source=p.source(),box=n.getBoundingClientRect();const {width,height,left,top}=viewport(w);
    const x=Math.max(0,box.left-left),y=Math.max(0,box.top-top),right=Math.min(width,box.right-left),bottom=Math.min(height,box.bottom-top);
    stats.photoSources++;if(right-x<60||bottom-y<60||(right-x)*(bottom-y)<box.width*box.height*.6){stats.photoGeometryRejected++;continue;}
    const stable=()=>{if(!live()||n.isConnected===false||!p.owned()||onePost(card,proof)!==id||p.source()!==source)return false;const r=n.getBoundingClientRect(),v=viewport(w);
     return ['width','height','left','top'].every(k=>Math.abs(v[k]-({width,height,left,top})[k])<1)&&Math.abs(r.left-box.left)<1&&Math.abs(r.top-box.top)<1&&Math.abs(r.width-box.width)<1&&Math.abs(r.height-box.height)<1&&[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].every(([px,py])=>{
      const cx=left+x+(right-x)*px,cy=top+y+(bottom-y)*py,hit=w.document.elementFromPoint(cx,cy);
      return hit&&!hit.closest(forbidden+',header,nav,aside,[role="menu"]')&&(hit===n||n.contains(hit)||root.FlipDesktopViewport.delegatedHit(w,n,hit,cx,cy));
     });};
    if(!stable()){stats.photoOccluded++;continue;}
    const saved=await capturePhoto(request,{action:'photos',width,height,tiles:[{postId:id,slot:0,x,y,width:right-x,height:bottom-y}]},stable,ms=>new Promise(resolve=>w.setTimeout(resolve,ms)),()=>live()&&w.performance.now()<end-3500);
    if(saved){captured.add(id);stats.photoPreviewFrames++;stats.photoPreviews++;stats.photoSelected++;break;}
   }
  }
  if(w.performance.now()>=end)break;
  const positions=selected.map(p=>[p.card,p.card.getBoundingClientRect().top]);const before=w.scrollY;const moved=()=>w.scrollY>before||positions.some(([n,y])=>n.isConnected!==false&&n.getBoundingClientRect().top<y-1);w.scrollBy({left:0,top:Math.max(400,Math.min(900,w.innerHeight*.8)),behavior:'instant'});stats.scrollSteps++;
  await new Promise(resolve=>w.setTimeout(resolve,Math.min(750,Math.max(0,end-w.performance.now()))));if(!moved()&&live()){
   const candidate=selected.find(({card})=>{const r=card.getBoundingClientRect();return r.width>100&&r.bottom>100&&r.top<w.innerHeight-100;});
   if(candidate){const r=candidate.card.getBoundingClientRect(),x=Math.max(.1,Math.min(.9,(r.left+r.width/2)/w.innerWidth)),y=Math.max(.1,Math.min(.9,(Math.max(0,r.top)+Math.min(w.innerHeight,r.bottom))/2/w.innerHeight)),hit=w.document.elementFromPoint(x*w.innerWidth,y*w.innerHeight);
    if(hit&&candidate.card.contains(hit)&&!hit.closest(forbidden+',button,[role="button"]')&&onePost(candidate.card,proof)===candidate.id){stats.nativeRequests++;stats.scrollNativeSteps++;const ack=await request({action:'scroll',x,y});if(!ack)stats.nativeTimeout++;else if(!ack.accepted)stats.nativeRejected++;await new Promise(resolve=>w.setTimeout(resolve,Math.min(200,Math.max(0,end-w.performance.now()))));if(moved())stats.scrollNativeMoves++;}
   }
  }
  if(moved())stats.scrollMoves++;else stats.scrollStalls++;
 }
 if(!live())return stop('PROFILE_CONTEXT_REJECTED');stats.scrollElapsedMs=Math.min(45000,Math.round(w.performance.now()-start));stats.candidates=rows.size;stats.mediaBindingPosts=captured.size;
 const result=[...rows.values()];for(const r of result)r.photos=Number(captured.has(r.postId));
 return {sourceId:m.sourceId,status:'OK',reason:'DONE',rows:result,stats,postTexts:[...texts].filter(([id])=>rows.has(id)).map(([postId,text])=>({postId,permalink:`https://www.facebook.com/${m.sourceId}/posts/${postId}/`,text}))};
}
function ocr(m,fields,preview){
 const stop=()=>({type:'profileOcrFieldsResult',status:'STOP',reason:'CONTEXT',rows:[],stats:preview.zero()});
 if(m?.consent!==true||!/^[-a-f0-9]{36}$/.test(m.nonce||'')||!sourceId(m.sourceId)||!postId(m.postId)||!Array.isArray(m.texts)||m.texts.length<1||m.texts.length>3||m.texts.some(t=>typeof t!=='string'||!t.trim()||t.length>12000)||m.texts.reduce((n,t)=>n+t.length,0)>24000)return stop();
 const values=m.texts.map(original=>{
  const text=original.replace(/\bzl\b/giu,'zł').replace(/(\d+(?:[.,]\d+)?)\s+metr(?:y|ów|ow)\b(?!\s+(?:od|do)\b)/giu,'$1 m2').replace(/(\d)\s*m\s*2\b/giu,'$1 m²');
  const r=row(m.postId,m.sourceId,text,fields,preview);
  if(!/\b(?:[1-9]|1[0-9]|20)\s*[-–]?\s*poko[ji]/iu.test(original))r.rooms=null;
  if(!/\d(?:[.,]\d+)?\s*m\s*[²2]|\d(?:[.,]\d+)?\s+metr(?:y|ów|ow)\b(?!\s+(?:od|do)\b)/iu.test(original))r.area=null;
  return r;
 });
 const out={...values[0]};let conflict=false;
 for(const key of ['price','area','rooms','district','neighborhood','street']){
  const distinct=[...new Set(values.map(r=>r[key]).filter(v=>v!==null))];out[key]=distinct.length===1?distinct[0]:null;if(distinct.length>1)conflict=true;
 }
 if(out.price===null)out.priceSource='NONE';else out.priceSource=values.find(r=>r.price===out.price).priceSource;
 if(conflict){out.usable=false;out.qualification='CONFLICT';}
 else if(values.some(r=>r.qualification==='FOREIGN_CITY')){out.usable=false;out.qualification='FOREIGN_CITY';}
 else if(values.some(r=>!['UNKNOWN','SELL_PROPERTY'].includes(r.intent))){out.usable=false;out.qualification='INTENT';}
 else if(values.some(r=>r.intent==='SELL_PROPERTY'&&r.usable)){out.intent='SELL_PROPERTY';out.usable=true;out.qualification='CANDIDATE';}
 const stats=preview.zero();stats.verified=1;stats.candidates=1;
 return {type:'profileOcrFieldsResult',status:'OK',reason:'DONE',rows:[out],stats};
}
const api={identity,link,onePost,cards,row,run,postId,ocr,capturePhoto,viewport};if(typeof module!=='undefined')module.exports=api;root.FlipProfileReader=api;
})(globalThis);
