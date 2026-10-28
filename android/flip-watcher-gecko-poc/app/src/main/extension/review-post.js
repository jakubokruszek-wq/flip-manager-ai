/* Fresh native consent, one exact permalink, DOM and embedded JSON only. No network, storage or input values. */
(function(root){'use strict';
function exact(raw,group,id,fixture=false){try{const u=new URL(raw);return /^\d{5,30}$/.test(id)&&/^[A-Za-z0-9._-]{1,100}$/.test(group)&&!u.username&&!u.password&&!u.search&&!u.hash&&((u.protocol==='https:'&&!u.port&&['www.facebook.com','facebook.com','m.facebook.com'].includes(u.hostname))||(fixture&&u.protocol==='http:'&&u.hostname==='127.0.0.1'))&&['/groups/'+group+'/posts/'+id+'/','/groups/'+group+'/permalink/'+id+'/'].includes(u.pathname.endsWith('/')?u.pathname:u.pathname+'/');}catch{return false;}}
const blocked='input[type="password"],form[action*="login"],form[action*="checkpoint"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"]';
const excluded='[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],[data-testid*="shared"],[data-ad-rendering-role*="shared"],blockquote,form,input,textarea,[contenteditable="true"]';
const evidenceKeys=['articleNodes','boundCards','nestedCards','foreignParents','messageNodes','scriptNodes','scriptParsed','scriptMatched','scriptSkipped','budgetLimited','readerStage','readerErrors','hrefExact','attrExact','identityMissing','foreignGroup','foreignPost','commentIdentity','excludedCards','manyLinks','rejectQuery','rejectRegion','canonicalSeen','canonicalExact','canonicalConflict','primaryCandidates','canonicalBound','recordReturned','recordInvalid','recordOtherId','recordLinkRejected','recordShared','recordAccepted','recordNoText','recordLimit','scriptOversize','scriptByteLimit','scriptTimeLimit','scriptNodeLimit','scriptParseLimit','parsedDataBlocks','parsedOtherBlocks','selectedBlocks','selectedStories','selectedCoreRecords','selectorRejected','selectorIncomplete','sourceKiB'];
function evidence(){return Object.fromEntries(evidenceKeys.map(k=>[k,0]));}
function links(card,core,preview,group,base,audit=null){
 const bump=k=>{if(audit)audit[k]=Math.min(10000,(audit[k]||0)+1);};
 const anchors=[...new Set([...Array.from(card.querySelectorAll('a[href]')),...Array.from(card.querySelectorAll('a[data-href],a[data-url],[role="link"][data-href],[role="link"][data-url]'))])];
 if(anchors.length>100){bump('manyLinks');return null;}const found=[];
 for(const a of anchors){
  if(a.closest('[role="article"],article')!==card)continue;
  const values=[{value:a.href,attr:false},...['data-href','data-url'].map(key=>({value:a.getAttribute?.(key),attr:true}))];
  for(const entry of values){
   if(typeof entry.value!=='string'||!entry.value||entry.value.length>2048)continue;
   try{const u=new URL(entry.value,base);if(u.protocol!=='https:'||u.port||u.username||u.password||!['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))continue;
    const parsed=core.parsePostLink(u.href);if(!parsed)continue;
    const query=!!(u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id')||u.hash),region=!!(a.closest(excluded)||a.closest('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-ad-rendering-role="message"],[data-ad-rendering-role="story_message"]'));
    const clean=!query&&!region;if(query)bump('rejectQuery');if(region)bump('rejectRegion');if(!clean)bump('commentIdentity');
    found.push({...parsed,clean,exact:preview.exact(u.href,group)===parsed.postId,attr:entry.attr});
   }catch{}
  }
 }
 return found;
}
function cardId(card,core,preview,group,base){const found=links(card,core,preview,group,base);if(!found?.length)return null;const ids=new Set(found.map(x=>x.postId));return ids.size===1&&found.every(x=>x.sourceType==='GROUP'&&x.sourceId===group)&&found.some(x=>x.exact&&x.clean)?found[0].postId:null;}
// Alternative proof for a directly opened, canonical post document. Never pick
// the first of multiple cards or derive an ID from text, comments or photo IDs.
function canonicalPrimary(w,m,core,preview,audit=evidence()){
 if(m.consent!==true||!(m.reviewConsent===true||m.ocrConsent===true)||w.location.href!==m.expectedUrl||!exact(w.location.href,m.groupId,m.postId,m.fixture===true))return [];
 const metas=Array.from(w.document.head?.querySelectorAll('link[rel="canonical"][href],meta[property="og:url"][content]')||[]);
 audit.canonicalSeen=Math.min(10000,metas.length);if(!metas.length||metas.length>8)return [];
 for(const n of metas){const value=n.getAttribute?.(n.tagName?.toUpperCase()==='LINK'?'href':'content');if(typeof value!=='string'||value.length>2048||!exact(value,m.groupId,m.postId,false)){audit.canonicalConflict++;return [];}}
 audit.canonicalExact=1;
 const regions=Array.from(w.document.querySelectorAll('main,[role="main"]')).filter(n=>n.ownerDocument===w.document&&n.isConnected!==false&&!n.closest(excluded)&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false);
 if(regions.length!==1)return [];const region=regions[0];
 const nodes=Array.from(region.querySelectorAll('[role="article"],article'));if(nodes.length>100)return [];
 const primary=nodes.filter(c=>c.ownerDocument===w.document&&c.isConnected!==false&&!c.parentElement?.closest('[role="article"],article')&&!c.closest(excluded)&&!/comment|komentarz|reply|odpowiedź/i.test(c.getAttribute?.('aria-label')||'')&&c.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false);
 audit.primaryCandidates=primary.length;if(primary.length!==1)return [];const card=primary[0];
 const own=links(card,core,preview,m.groupId,w.location.href);if(own===null||own.some(x=>x.sourceType!=='GROUP'||x.sourceId!==m.groupId||x.postId!==m.postId))return [];
 const belongs=n=>n.ownerDocument===w.document&&n.isConnected!==false&&n.closest('[role="article"],article')===card&&!n.closest(excluded)&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;
 const messages=Array.from(card.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-ad-rendering-role="message"],[data-ad-rendering-role="story_message"]'));if(messages.length>30)return [];
 const images=Array.from(card.querySelectorAll('img')).slice(0,100);
 if(!messages.some(belongs)&&!images.some(n=>belongs(n)&&n.complete&&n.naturalWidth>=200&&n.naturalHeight>=120))return [];
 audit.canonicalBound=1;return [card];
}
function cards(w,m,core,preview,audit=evidence()){
 const nodes=Array.from(w.document.querySelectorAll('[role="article"],article'));audit.articleNodes=Math.min(10000,nodes.length);if(nodes.length>100)return [];
 const result=[];
 for(const c of nodes){
  if(c.ownerDocument!==w.document||c.isConnected===false||c.closest(excluded)){audit.excludedCards++;continue;}
  const found=links(c,core,preview,m.groupId,w.location.href,audit);if(!found?.length){audit.identityMissing++;continue;}
  if(found.some(x=>x.sourceType!=='GROUP'||x.sourceId!==m.groupId)){audit.foreignGroup++;continue;}
  if(new Set(found.map(x=>x.postId)).size!==1||found[0].postId!==m.postId){audit.foreignPost++;continue;}
  const exact=found.filter(x=>x.clean&&x.exact);if(!exact.length){audit.identityMissing++;continue;}
  if(exact.some(x=>!x.attr))audit.hrefExact++;else audit.attrExact++;
  let parent=c.parentElement?.closest('[role="article"],article'),depth=0,foreign=false,nested=!!parent;
  while(parent&&depth++<20){
   if(parent.ownerDocument!==w.document||parent.closest(excluded)){foreign=true;break;}
   const ancestors=links(parent,core,preview,m.groupId,w.location.href);if(ancestors===null||ancestors.length>0){foreign=true;break;}
   parent=parent.parentElement?.closest('[role="article"],article');
  }
  if(parent||foreign){audit.foreignParents++;continue;}if(nested)audit.nestedCards++;result.push(c);
 }
 if(!result.length)result.push(...canonicalPrimary(w,m,core,preview,audit));audit.boundCards=result.length;return result;
}
// Select an own Story from deeply nested JSON without building the full payload
// object graph. Every ancestor is retained while scanning: comments, shared
// stories and attachments cannot become root-owned text after projection.
const photoProofs=new WeakMap();
function ownPhotoSources(w,m){const p=photoProofs.get(w.document);return p&&p.url===w.location.href&&p.url===m.expectedUrl&&p.id===m.postId&&p.group===m.groupId?p.sources:[];}
function selectOwnStoryData(body,group,id,now,deadline,collectPhotos=false){
 const empty=(valid=false,limited=false,unsupported=false)=>({bodies:[],valid,limited,unsupported,rejected:0});
 if(typeof body!=='string'||body.length>4194304)return empty(false,true);
 let i=body.charCodeAt(0)===0xfeff?1:0;
 function whitespace(){while(/[\t\n\r ]/.test(body[i]||'x')){if((i&4095)===0&&now()>=deadline)return false;i++;}return true;}
 if(!whitespace())return empty(false,true);
 if(body.startsWith('for(;;);',i))i+=8;
 if(!whitespace())return empty(false,true);
 if(!['{','['].includes(body[i]))return empty(false,false,true);
 const frames=[],outputs=[];let root=false,members=0,objects=0,rejected=0,limited=false;
 const ids=['post_id','postId','story_fbid','story_id','storyId'],urls=['url','permalink','permalink_url'];
 const interesting=new Set([...ids,'id','__typename','typename',...urls,'message','text','body',...(collectPhotos?['uri','width','height']:[])]);
 const forbidden=k=>k!=='commentable_feed_story'&&/(?:comment|feedback|shared|quoted|crosspost|reshare|original_story|attached_story|attachment|media|caption)/i.test(k);
 const fail=()=>({bodies:[],valid:false,limited,unsupported:false,rejected});
 const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
 function takeValue(){
  const p=frames[frames.length-1];if(!p){if(root)return null;root=true;return{parent:null,key:null,blocked:false};}
  if(p.kind==='{'){if(p.state!=='value')return null;const key=p.key;p.state='after';return{parent:p,key,blocked:p.blocked||forbidden(key)};}
  if(!['first','value'].includes(p.state))return null;p.state='after';return{parent:p,key:null,blocked:p.blocked};
 }
 function scalar(relation,value){
  const p=relation.parent,k=relation.key;if(!p||p.kind!=='{'||!interesting.has(k))return;
  if(['message','text','body'].includes(k)){if(typeof value==='string'&&value.length<=20000)p.messages[k]=value;return;}
  p.own[k]=value;
 }
 function sourceLink(raw){try{
  const u=new URL(raw);if(u.hash||u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id'))return null;
  u.search='';return exact(u.href,group,id)?u.href:null;
 }catch{return null;}}
 function identity(f){
  const present=[...ids,'id'].filter(k=>typeof f.own[k]==='string'&&/^\d{5,30}$/.test(f.own[k]));
  const explicit=ids.find(k=>present.includes(k)),type=f.own.__typename||f.own.typename||'',typed=typeof type==='string'&&/story|post/i.test(type);
  const key=explicit||typed&&present.includes('id')&&'id';
  return {key,id:key?f.own[key]:null,type,valid:!!key&&(!type||typed),conflict:!!key&&present.some(k=>f.own[k]!==f.own[key])};
 }
 function foreignPostLink(f,owner){
  if(!owner.key&&!/story|post/i.test(String(owner.type)))return false;
  return urls.some(k=>{try{const u=new URL(f.own[k]);return u.protocol==='https:'&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)&&/^\/groups\/[^/]+\/(?:posts|permalink)\/\d{5,30}\/?$/.test(u.pathname)&&!sourceLink(u.href);}catch{return false;}});
 }
 function finishMedia(f){
  if(!collectPhotos||f.mediaBlocked)return;
  const owner=identity(f),type=String(owner.type);
  if(owner.conflict||foreignPostLink(f,owner)||owner.key&&(!owner.valid||owner.id!==id)||/story|post/i.test(type)&&(!owner.valid||owner.id!==id)||/comment|feedback|shared|quoted|crosspost|reshare|reply|video|actor|profile/i.test(type))return;
  // A URI is media evidence only below a typed Photo, never a free URL or avatar.
  if(/^(?:image|photo_image|viewer_image|large_image|full_image|preview_image|large_share_image|thumbnail_image)$/i.test(f.relation.key||'')&&Number(f.own.width)>=200&&Number(f.own.height)>=120){
   try{const u=new URL(f.own.uri);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&/(?:^|\.)fbcdn\.net$/i.test(u.hostname)&&u.href.length<=8192&&f.mediaRaw.size<20)f.mediaRaw.add(u.href);}catch{}
  }
  if(type==='Photo'){for(const src of f.mediaRaw)if(f.mediaPhotos.size<20)f.mediaPhotos.add(src);f.mediaRaw.clear();}
  const p=f.relation.parent;if(p){for(const src of f.mediaPhotos)if(p.mediaPhotos.size<20)p.mediaPhotos.add(src);for(const src of f.mediaRaw)if(p.mediaRaw.size<20)p.mediaRaw.add(src);}
 }
 function finish(f){
  const owner=identity(f),linkKeys=urls.filter(k=>Object.hasOwn(f.own,k));
  for(const k of linkKeys){const url=sourceLink(f.own[k]);if(url&&f.links.size<8)f.links.add(url);}
  const ownText=['message','text','body'].map(k=>f.messages[k]).find(t=>typeof t==='string'&&t.trim());
  const text=ownText||(f.childTexts.size===1?[...f.childTexts][0]:null);
  const semanticBlock=/comment|feedback|shared|quoted|crosspost|reshare|reply/i.test(String(owner.type));
  if(owner.id===id){
   const invalidLink=linkKeys.some(k=>!sourceLink(f.own[k]));
   if(f.blocked||semanticBlock||owner.conflict||!owner.valid||invalidLink||!f.links.size){rejected++;}
   else{
    const result=Object.create(null);result[owner.key]=owner.id;result.permalink_url=[...f.links][0];
    if(f.own.__typename)result.__typename=f.own.__typename;else if(f.own.typename)result.typename=f.own.typename;
    if(text)result.message={text};
    const candidate={data:result,ancestors:frames.slice(),photos:collectPhotos?[...f.mediaPhotos]:[]};
    if(outputs.length>=8){limited=true;const empty=outputs.findIndex(o=>!o.data.message);if(text&&empty>=0)outputs[empty]=candidate;}
    else outputs.push(candidate);
   }
  }
  const p=f.relation.parent,k=f.relation.key;
  if(p&&!f.blocked&&!semanticBlock&&!owner.conflict&&(!owner.valid||owner.id===id)){
   for(const url of f.links)if(p.links.size<8)p.links.add(url);
   if(owner.valid&&owner.id===id&&text&&p.childTexts.size<2)p.childTexts.add(text);
   else for(const t of f.childTexts)if(p.childTexts.size<2)p.childTexts.add(t);
   if(p.kind==='{'&&['message','text','body'].includes(k)&&!owner.key&&typeof f.messages.text==='string')p.messages[k]=f.messages.text;
  }
  return true;
 }
 while(i<body.length){
  if((i&4095)===0&&now()>=deadline){limited=true;return fail();}
  const c=body[i];if(/[\t\n\r ]/.test(c)){i++;continue;}
  const f=frames[frames.length-1];
  if(c==='"'){
   const start=i++;let closed=false;
   while(i<body.length){
    if((i&4095)===0&&now()>=deadline){limited=true;return fail();}
    const ch=body[i++];if(ch==='"'){closed=true;break;}
    if(ch.charCodeAt(0)<32)return fail();
    if(ch==='\\'){const e=body[i++];if(e==='u'){if(!/^[0-9a-fA-F]{4}$/.test(body.slice(i,i+4)))return fail();i+=4;}else if(!e||!'"\\/bfnrt'.includes(e))return fail();}
   }
   if(!closed)return fail();
   if(f?.kind==='{'&&['first','key'].includes(f.state)){
    if(i-start>1024||++members>20000){limited=true;return fail();}
    let key;try{key=JSON.parse(body.slice(start,i));}catch{return fail();}
    // Duplicate keys can hide an earlier subtree; never lift from that document.
    if(f.keys.has(key))return fail();f.keys.add(key);f.key=key;f.state='colon';continue;
   }
   const relation=takeValue();if(!relation)return fail();
   if(relation.parent&&interesting.has(relation.key)){
    const max=['message','text','body'].includes(relation.key)?120002:8194;
    let value=null;if(i-start<=max){try{value=JSON.parse(body.slice(start,i));}catch{return fail();}}
    scalar(relation,value);
   }
   continue;
  }
  if(c==='{'||c==='['){
   const relation=takeValue();if(!relation)return fail();
   if(frames.length>=128||++objects>20000){limited=true;return fail();}
   frames.push({kind:c,state:'first',key:null,keys:new Set(),own:Object.create(null),messages:Object.create(null),links:new Set(),childTexts:new Set(),blocked:relation.blocked,mediaBlocked:!!relation.parent?.mediaBlocked||/comment|feedback|shared|quoted|crosspost|reshare|original_story|attached_story|actor|profile|avatar|icon|video|caption/i.test(relation.key||'')&&relation.key!=='commentable_feed_story',mediaRaw:new Set(),mediaPhotos:new Set(),relation});i++;continue;
  }
  if(c==='}'||c===']'){
   if(!f||f.kind!==(c==='}'?'{':'[')||!['first','after'].includes(f.state))return fail();
   frames.pop();finishMedia(f);if(f.kind==='{'&&finish(f)===false)return fail();i++;continue;
  }
  if(c===':'){if(f?.kind!=='{'||f.state!=='colon')return fail();f.state='value';i++;continue;}
  if(c===','){if(!f||f.state!=='after')return fail();f.state=f.kind==='{'?'key':'value';i++;continue;}
  const relation=takeValue();if(!relation)return fail();
  if(c==='t'&&body.startsWith('true',i)){scalar(relation,null);i+=4;continue;}
  if(c==='f'&&body.startsWith('false',i)){scalar(relation,null);i+=5;continue;}
  if(c==='n'&&body.startsWith('null',i)){scalar(relation,null);i+=4;continue;}
  number.lastIndex=i;const match=number.exec(body);if(!match)return fail();i=number.lastIndex;
  const n=Number(match[0]);scalar(relation,collectPhotos&&['width','height'].includes(relation.key)&&Number.isSafeInteger(n)?n:Number.isSafeInteger(n)&&/^\d{5,15}$/.test(match[0])?match[0]:null);
 }
 if(frames.length||!root)return fail();
 const accepted=outputs.filter(candidate=>!candidate.ancestors.some(a=>{
  const owner=identity(a);return a.blocked||owner.conflict||foreignPostLink(a,owner)||owner.valid&&owner.id!==id||/comment|feedback|shared|quoted|crosspost|reshare|reply/i.test(String(owner.type));
 }));
 rejected+=outputs.length-accepted.length;
 return {bodies:accepted.map(o=>JSON.stringify(o.data)),valid:true,limited,unsupported:false,rejected,...(collectPhotos?{photos:[...new Set(accepted.flatMap(o=>o.photos))].slice(0,20)}:{})};
}

function create(){const used=new Set();return {read(w,m,core,fields,preview){
 const audit=evidence();const count=(key,n=1)=>{audit[key]=Math.min(10000,audit[key]+n);};let model=null;const empty=(reason='CONTEXT')=>({status:'STOP',reason,rows:[],stats:preview.zero(),bound:0,textRead:0,evidence:{...audit}});
 try{audit.readerStage=1;
 const safe=()=>m.consent===true&&m.reviewConsent===true&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.nonce||'')&&w.location.href===m.expectedUrl&&exact(w.location.href,m.groupId,m.postId,m.fixture===true)&&['interactive','complete'].includes(w.document.readyState)&&w.document.visibilityState==='visible'&&w.document.hidden!==true&&w.document.hasFocus?.()===true&&!/log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość/i.test(w.document.title||'')&&!w.document.querySelector(blocked)&&!w.document.querySelector('[role="alertdialog"]');
 if(!safe()||used.has(m.nonce))return empty();used.add(m.nonce);while(used.size>32)used.delete(used.values().next().value);
 photoProofs.delete(w.document);const ownPhotos=new Set();
 model=preview.createModel(core,fields,m.groupId);let bound=0,textRead=0;
 audit.readerStage=2;
  if(m.previousRow?.postId!==m.postId||!model.merge(m.previousRow))return empty();
  audit.readerStage=3;const ownCards=cards(w,m,core,preview,audit);if(audit.articleNodes>100)return empty();
  // The URL alone never identifies an arbitrary suggested/comment card.
  for(const card of ownCards.slice(0,20)){
   bound=1;let region=card;
   const zone=card.closest('[role="dialog"]')||card.closest('main,[role="main"]');
   if(zone&&audit.canonicalBound!==1){const links=zone.querySelectorAll('a[href]');if(links.length<=200){const posts=Array.from(links).map(n=>core.parsePostLink(n.href)).filter(Boolean);if(posts.length&&posts.every(p=>p.sourceType==='GROUP'&&p.sourceId===m.groupId&&p.postId===m.postId))region=zone;}}
   audit.readerStage=4;const markers=region.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-ad-rendering-role="message"],[data-ad-rendering-role="story_message"]');
   audit.messageNodes=Math.min(10000,audit.messageNodes+markers.length);const own=markers.length<=30?Array.from(markers).filter(n=>n.ownerDocument===w.document&&!n.closest(excluded)&&(n.closest('[role="article"],article')===card||region!==card&&!n.closest('[role="article"],article'))&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false):[];
   const top=own.filter(n=>!own.some(p=>p!==n&&p.contains(n))),texts=new Set();
   for(const n of top){
    // Read text nodes in the selected message, pruning comments/forms/quotes and
    // independent cards. Never read a form value or the whole document body.
    const walker=w.document.createTreeWalker(n,5,{acceptNode(node){if(node.nodeType===1){const c=node.closest(excluded);if(c||node.matches('script,style,noscript,button,[role="button"]')||node!==card&&node.matches('[role="article"],article')||node.closest('[hidden],[aria-hidden="true"]'))return 2;const style=w.getComputedStyle(node);if(style.display==='none'||/hidden|collapse/.test(style.visibility)||Number(style.opacity??1)<=0)return 2;}return 1;}});
    let out='',count=0,node;while((node=walker.nextNode())&&count++<3000&&out.length<12000){if(node.nodeType===3)out+=node.textContent||'';else if(/^(?:BR|DIV|P|LI|SECTION)$/.test(node.tagName))out+='\n';}
    const text=preview.messageText(out.slice(0,12000));if(text)texts.add(text);
   }
   if(texts.size===1){const text=[...texts][0];textRead=1;model.add({postId:m.postId,permalink:m.previousRow.permalink,text,media:[]},'DOM');}
  }
  // Exact same-post structured records may contain text absent from rendered markers.
  audit.readerStage=5;let bytes=0,sourceChars=0,probeChars=0;const scripts=w.document.querySelectorAll('script:not([src])');audit.scriptNodes=Math.min(10000,scripts.length);
  const now=()=>w.performance?.now?.()??Date.now(),started=now();
  const directHint=new RegExp('"(?:post_id|postId|story_fbid|story_id|storyId)"\\s*:\\s*(?:"'+m.postId+'"|'+m.postId+'(?=\\s*[,}]))');
  const genericHint=new RegExp('"id"\\s*:\\s*(?:"'+m.postId+'"|'+m.postId+'(?=\\s*[,}]))');
  const source={sourceType:'GROUP',sourceId:m.groupId,sourceUrl:'https://www.facebook.com/groups/'+m.groupId+'/',allowGroupRedirect:false};
  function consume(payload,priority,ids,selected=false){
   if(audit.scriptParsed>=64){audit.budgetLimited=1;audit.scriptParseLimit=1;return false;}
   let records=[];audit.scriptParsed++;count(priority===0?'parsedDataBlocks':'parsedOtherBlocks');
   records=core.extractStructuredRecordsFromText(payload,'HYDRATION',source)||[];
   if(!Array.isArray(records))throw Error('PARSER_SHAPE');
   if(selected)count('selectedCoreRecords',records.length);
   count('recordReturned',records.length);if(records.length>100){audit.recordLimit=1;audit.budgetLimited=1;}
   for(const r of records.slice(0,100)){
    if(!r||typeof r!=='object'){count('recordInvalid');continue;}
    if(r.postId!==m.postId){count('recordOtherId');continue;}
    if(!ids.has(m.postId)||preview.exact(r.permalink,m.groupId)!==m.postId){count('recordLinkRejected');continue;}
    const path=r.__structuredDiagnostics?.structuredTextPath;
    if(typeof path==='string'&&/(?:shared|quoted|crosspost|reshare|original_story|attached_story)/i.test(path)){count('recordShared');continue;}
    count('recordAccepted');const hasText=typeof r.text==='string'&&!!r.text.trim();if(!hasText)count('recordNoText');
    bound=1;if(hasText)textRead=1;model.add(r,'HYDRATION');
   }
   return true;
  }
  const candidates=[];
  for(let i=0;i<Math.min(256,scripts.length);i++){
   const node=scripts[i],type=String(node.getAttribute?.('type')||'').trim().toLowerCase();
   candidates.push({node,priority:Number(!(/^(?:application\/(?:ld\+)?json)$/.test(type)||node.hasAttribute?.('data-sjs')))});
  }
  candidates.sort((a,b)=>a.priority-b.priority);
  if(scripts.length>256){audit.budgetLimited=1;audit.scriptNodeLimit=1;}
  scanScripts:for(const {node,priority} of candidates){
   if(now()-started>=500){audit.budgetLimited=1;audit.scriptTimeLimit=1;break;}
   const body=node.textContent||'';if(!body){audit.scriptSkipped++;continue;}
   const large=body.length>524288;if(large)count('scriptOversize');
   // Flat string screening has its own hard aggregate cap; never build a giant AST.
   if(body.length>4194304||probeChars+body.length>8388608){audit.selectorIncomplete=1;audit.budgetLimited=1;audit.scriptSkipped++;continue;}probeChars+=body.length;
   const unicodeHint=/\\u003[0-9]/.test(body);
   const hint=body.includes(m.postId)||unicodeHint;
   const identityHint=hint&&(unicodeHint||directHint.test(body)||genericHint.test(body)&&/"(?:__typename|typename)"\s*:\s*"[^"]{0,100}(?:Story|Post)[^"]{0,100}"/i.test(body));
   if(hint&&!identityHint){let head=body.trimStart();if(head.startsWith('for(;;);'))head=head.slice(8).trimStart();if(priority===0||head[0]==='{'||head[0]==='['){audit.scriptSkipped++;continue;}}
   if(identityHint){
    if(sourceChars+body.length>4194304){audit.selectorIncomplete=1;audit.budgetLimited=1;audit.scriptSkipped++;continue;}
    sourceChars+=body.length;audit.sourceKiB=Math.ceil(sourceChars/1024);count('selectedBlocks');
    const selected=selectOwnStoryData(body,m.groupId,m.postId,now,started+500,true);count('selectorRejected',selected.rejected);
    if(selected.limited){audit.selectorIncomplete=1;audit.budgetLimited=1;}
    if(selected.valid&&selected.bodies.length){
     count('selectedStories',selected.bodies.length);audit.scriptMatched++;for(const src of selected.photos||[])if(ownPhotos.size<20)ownPhotos.add(src);
     for(const payload of selected.bodies){
      // Recheck actual projected source URL evidence with the unchanged parser.
      const ids=preview.explicitIds(payload,m.groupId);if(!ids.has(m.postId))continue;
      if(payload.length>131072||bytes+payload.length>2097152){audit.scriptByteLimit=1;audit.budgetLimited=1;continue;}bytes+=payload.length;
      if(!consume(payload,priority,ids,true))break scanScripts;
     }
     continue;
    }
    // A valid JSON boundary rejected for ownership must not be reinterpreted
    // without its ancestors by the legacy walker. Malformed JSON also fails closed.
    if(selected.valid||selected.rejected||!selected.unsupported){audit.scriptSkipped++;continue;}
   }
   if(large){audit.scriptSkipped++;continue;}
   if(bytes+body.length>2097152){audit.budgetLimited=1;audit.scriptByteLimit=1;audit.scriptSkipped++;continue;}bytes+=body.length;
   const ids=preview.explicitIds(body,m.groupId);if(!ids.has(m.postId)){audit.scriptSkipped++;continue;}audit.scriptMatched++;
   if(!consume(body,priority,ids))break;
  }
  if(!safe())return empty();const row=model.rows().find(r=>r.postId===m.postId);if(!row)return empty();
  const stats=preview.zero();stats.verified=1;stats.candidates=1;stats.desktop=Number(w.innerWidth>=900);
  if(bound)photoProofs.set(w.document,{url:w.location.href,id:m.postId,group:m.groupId,sources:Object.freeze([...ownPhotos])});
  audit.readerStage=6;return {status:'OK',reason:'DONE',rows:[row],stats,bound,textRead,evidence:{...audit}};
 }catch{audit.readerErrors=1;return empty('ERROR');}finally{model?.clear();}
}};}
const api={exact,create,cards,cardId,canonicalPrimary,selectOwnStoryData,ownPhotoSources,evidenceKeys};if(typeof module!=='undefined')module.exports=api;root.FlipReviewPost=api;
})(globalThis);
