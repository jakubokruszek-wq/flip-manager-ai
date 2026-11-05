/* Native-triggered joined-group metadata only. No requests, posts, media or page bridge. */
(function(root){'use strict';
const hosts=new Set(['www.facebook.com','m.facebook.com','facebook.com']);
const reserved=new Set(['joins','feed','discover','create','notifications','your_groups']);
const excluded='nav,header,aside,[role="navigation"],[role="complementary"],[role="dialog"],[role="alertdialog"]';
function page(raw,fixture=false){try{const u=new URL(raw);return !u.username&&!u.password&&!u.hash&&(u.protocol==='https:'&&!u.port&&hosts.has(u.hostname)||fixture&&u.protocol==='http:'&&u.hostname==='127.0.0.1')&&/^\/groups\/joins\/?$/.test(u.pathname);}catch{return false;}}
function group(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.port||u.username||u.password||!hosts.has(u.hostname))return null;const id=/^\/groups\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(u.pathname)?.[1]?.toLowerCase();return id&&!reserved.has(id)?{id,url:'https://www.facebook.com/groups/'+id+'/'}:null;}catch{return null;}}
function name(anchor,id){
 for(const value of [anchor.getAttribute?.('aria-label'),anchor.getAttribute?.('title'),anchor.innerText]){
  if(typeof value!=='string')continue;
  const text=value.replace(/^(?:grupa|group):\s*/iu,'').replace(/\s+/g,' ').trim();
  if(!text||text===id||text.length>200||/[\p{Cc}]|https?:\/\//u.test(text)||/^(?:grupa|group|zobacz grupę|view group|zdjęcie profilowe.*|profile photo.*|dołącz|join)$/iu.test(text))continue;
  return text;
 }
 return null;
}
function joinCard(anchor){
 for(let p=anchor.parentElement,depth=0;p&&depth<5;p=p.parentElement,depth++){
  const links=Array.from(p.querySelectorAll('a[href]')).map(n=>group(n.href)?.id).filter(Boolean);
  if(new Set(links).size>1)break;
  if(Array.from(p.querySelectorAll('button,[role="button"]')).some(n=>[n.innerText,n.getAttribute?.('aria-label'),n.getAttribute?.('title')].some(t=>typeof t==='string'&&/^(?:dołącz|join)\b/iu.test(t.trim()))))return true;
 }
 return false;
}
function inspect(w){
 const main=w.document.querySelector('[role="main"],main');if(!main)return {groups:[],examined:0,rejected:0,duplicates:0};
 const anchors=Array.from(main.querySelectorAll('a[href]')).slice(0,2000),seen=new Map();let rejected=0,duplicates=0;
 for(const a of anchors){
  const source=group(a.href);const rect=a.getBoundingClientRect();
  if(!source||a.isConnected===false||a.closest(excluded)||rect.width<=0||rect.height<=0||joinCard(a)){rejected++;continue;}
  const style=w.getComputedStyle(a);if(style.display==='none'||/hidden|collapse/.test(style.visibility)||Number(style.opacity??1)<=0){rejected++;continue;}
  const label=name(a,source.id),old=seen.get(source.id);
  if(old){duplicates++;if(old.name===null&&label!==null)old.name=label;continue;}
  if(seen.size>=200){rejected++;continue;}seen.set(source.id,{url:source.url,name:label});
 }
 return {groups:[...seen.values()],examined:anchors.length,rejected,duplicates};
}
function scrollRoot(w){
 const main=w.document.querySelector('[role="main"],main');
 const options=[main,...Array.from(main?.querySelectorAll('div')||[]).slice(0,300)].filter(Boolean);
 return options.find(n=>n.scrollHeight-n.clientHeight>32&&/^(?:auto|scroll|overlay)$/.test(w.getComputedStyle(n).overflowY)&&!n.closest(excluded)&&Array.from(n.querySelectorAll('a[href]')).some(a=>group(a.href)))||w.document.scrollingElement;
}
async function run(w,m){
 const stats={examined:0,accepted:0,namesFound:0,rejected:0,duplicates:0,scrollSteps:0,scrollMoves:0,stabilized:0,pageVisible:0};
 const done=(status,reason,groups=[])=>({status,reason,groups,stats});
 if(m?.consent!==true||!/^[-a-f0-9]{36}$/.test(m.nonce||'')||!page(w.location.href,m.fixture===true))return done('STOP','DISCOVERY_CONTEXT_REJECTED');
 const href=w.location.href,time=w.performance.timeOrigin,all=new Map(),deadline=w.performance.now()+60000;
 const live=()=>w.location.href===href&&w.performance.timeOrigin===time&&page(w.location.href,m.fixture===true);
 const pause=()=>new Promise(r=>w.setTimeout(r,750));
 let initial=0,stalls=0;
 for(let step=0;step<60&&w.performance.now()<deadline&&all.size<200;){
  if(!live())return done('STOP','DISCOVERY_CONTEXT_REJECTED');
  if(w.document.querySelector('input[type="password"]'))return done('STOP','LOGIN_REQUIRED');
  if(Array.from(w.document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).some(n=>{const r=n.getBoundingClientRect(),s=w.getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}))return done('STOP','DISCOVERY_MODAL_BLOCKED');
  stats.pageVisible=Number(w.document.visibilityState==='visible'&&!w.document.hidden);
  if(!stats.pageVisible)return done('STOP','DISCOVERY_PAGE_HIDDEN');
  const read=inspect(w),before=all.size;
  stats.examined=Math.max(stats.examined,read.examined);stats.rejected=Math.max(stats.rejected,read.rejected);stats.duplicates=Math.max(stats.duplicates,read.duplicates);
  for(const entry of read.groups){const old=all.get(entry.url);if(old){if(old.name===null&&entry.name!==null)old.name=entry.name;}else if(all.size<200)all.set(entry.url,entry);}
  if(!all.size&&initial++<20){await pause();continue;}
  const target=scrollRoot(w);if(!target)break;
  const y=target.scrollTop;target.scrollBy({left:0,top:Math.max(200,Math.min(900,target.clientHeight*.8)),behavior:'instant'});stats.scrollSteps++;step++;await pause();
  if(!live())return done('STOP','DISCOVERY_CONTEXT_REJECTED');
  const moved=target.scrollTop>y;stats.scrollMoves+=Number(moved);
  const atEnd=target.scrollHeight-target.clientHeight-target.scrollTop<4;
  stalls=all.size===before&&!moved&&atEnd?stalls+1:0;
  if(stalls>=3){stats.stabilized=1;break;}
 }
 if(!live())return done('STOP','DISCOVERY_CONTEXT_REJECTED');
 stats.accepted=all.size;stats.namesFound=[...all.values()].filter(g=>g.name!==null).length;
 return done('OK',all.size?'DONE':'DISCOVERY_NO_GROUP_LINKS',[...all.values()]);
}
const api={page,group,name,inspect,run};if(typeof module!=='undefined')module.exports=api;root.FlipJoinedGroups=api;
})(globalThis);
