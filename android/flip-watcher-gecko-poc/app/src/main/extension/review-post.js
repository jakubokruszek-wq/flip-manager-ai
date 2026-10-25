/* Fresh native consent, one exact permalink, rendered DOM only. No network, storage or input values. */
(function(root){'use strict';
function exact(raw,group,id,fixture=false){try{const u=new URL(raw);return /^\d{5,30}$/.test(id)&&/^[A-Za-z0-9._-]{1,100}$/.test(group)&&!u.username&&!u.password&&!u.search&&!u.hash&&((u.protocol==='https:'&&!u.port&&['www.facebook.com','facebook.com','m.facebook.com'].includes(u.hostname))||(fixture&&u.protocol==='http:'&&u.hostname==='127.0.0.1'))&&['/groups/'+group+'/posts/'+id+'/','/groups/'+group+'/permalink/'+id+'/'].includes(u.pathname.endsWith('/')?u.pathname:u.pathname+'/');}catch{return false;}}
const blocked='input[type="password"],form[action*="login"],form[action*="checkpoint"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"]';
const excluded='[role="comment"],[data-testid*="comment"]:not([data-testid="commentable_feed_story"]),[data-ad-rendering-role*="comment"],[data-testid*="shared"],[data-ad-rendering-role*="shared"],blockquote,form,input,textarea,[contenteditable="true"]';
function create(){const used=new Set();return {read(w,m,core,fields,preview){
 const empty=()=>{const stats=preview.zero();stats.pageFocused=Number(w.document.hasFocus?.()===true);stats.pageVisible=Number(w.document.visibilityState==='visible'&&w.document.hidden!==true);stats.verified=Number(w.location.href===m.expectedUrl&&exact(w.location.href,m.groupId,m.postId,m.fixture===true));return {status:'STOP',reason:'CONTEXT',rows:[],stats,bound:0,textRead:0};};
 const safe=()=>m.consent===true&&m.reviewConsent===true&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.nonce||'')&&w.location.href===m.expectedUrl&&exact(w.location.href,m.groupId,m.postId,m.fixture===true)&&w.document.visibilityState==='visible'&&w.document.hidden!==true&&w.document.hasFocus?.()===true&&!/log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość/i.test(w.document.title||'')&&!w.document.querySelector(blocked)&&!w.document.querySelector('[role="alertdialog"]');
 if(!safe()||used.has(m.nonce))return empty();used.add(m.nonce);while(used.size>32)used.delete(used.values().next().value);
 const model=preview.createModel(core,fields,m.groupId);let bound=0,textRead=0;
 try{
  if(m.previousRow?.postId!==m.postId||!model.merge(m.previousRow))return empty();
  const nodes=w.document.querySelectorAll('[role="article"],article');if(nodes.length>100)return empty();
  const cards=Array.from(nodes).filter(c=>c.ownerDocument===w.document&&c.isConnected!==false&&!c.parentElement?.closest('[role="article"],article')&&!c.closest(excluded)&&preview.ownCardId(c,core,m.groupId)===m.postId&&Array.from(c.querySelectorAll('a[href]')).slice(0,100).some(a=>{if(a.closest('[role="article"],article')!==c)return false;try{const u=new URL(a.href);return preview.exact(a.href,m.groupId)===m.postId&&!u.searchParams.has('comment_id')&&!u.searchParams.has('reply_comment_id')&&!u.hash;}catch{return false;}}));
  // The URL alone never identifies an arbitrary suggested/comment card.
  for(const card of cards.slice(0,20)){
   bound=1;let region=card;
   const zone=card.closest('[role="dialog"]')||card.closest('main,[role="main"]');
   if(zone){const links=zone.querySelectorAll('a[href]');if(links.length<=200){const posts=Array.from(links).map(n=>core.parsePostLink(n.href)).filter(Boolean);if(posts.length&&posts.every(p=>p.sourceType==='GROUP'&&p.sourceId===m.groupId&&p.postId===m.postId))region=zone;}}
   const markers=region.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-ad-rendering-role="message"],[data-ad-rendering-role="story_message"]');
   const own=markers.length<=30?Array.from(markers).filter(n=>n.ownerDocument===w.document&&!n.closest(excluded)&&(n.closest('[role="article"],article')===card||region!==card&&!n.closest('[role="article"],article'))&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false):[];
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
  let bytes=0;const scripts=w.document.querySelectorAll('script:not([src])');
  for(let i=0;i<Math.min(64,scripts.length);i++){
   const body=scripts[i].textContent||'';if(!body||body.length>524288||bytes+body.length>2097152)continue;bytes+=body.length;
   let records=[];try{records=core.extractStructuredRecordsFromText(body,'HYDRATION',{sourceType:'GROUP',sourceId:m.groupId,sourceUrl:'https://www.facebook.com/groups/'+m.groupId+'/',allowGroupRedirect:false})||[];}catch{continue;}
   const ids=preview.explicitIds(body,m.groupId);
   for(const r of records.slice(0,100))if(r.postId===m.postId&&ids.has(m.postId)&&preview.exact(r.permalink,m.groupId)===m.postId){
    const path=r.__structuredDiagnostics?.structuredTextPath;
    if(typeof path==='string'&&/(?:shared|quoted|crosspost|reshare|original_story|attached_story)/i.test(path))continue;
    bound=1;if(typeof r.text==='string'&&r.text.trim())textRead=1;model.add(r,'HYDRATION');
   }
  }
  if(!safe())return empty();const row=model.rows().find(r=>r.postId===m.postId);if(!row)return empty();
  const stats=preview.zero();stats.verified=1;stats.candidates=1;stats.desktop=Number(w.innerWidth>=900);
  return {status:'OK',reason:'DONE',rows:[row],stats,bound,textRead};
 }finally{model.clear();}
}};}
const api={exact,create};if(typeof module!=='undefined')module.exports=api;root.FlipReviewPost=api;
})(globalThis);
