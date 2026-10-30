/* Private isolated-content helper. Observe one real operator swipe; never synthesize input. */
(function(root){'use strict';
const forbidden='[role="dialog"],[role="alertdialog"],[role="comment"],[data-testid*="comment"],[role="menu"],[role="listbox"],[role="complementary"],form,input,textarea,select,aside,nav,header';
function allowed(w,n){return !!n&&n.ownerDocument===w.document&&n.isConnected!==false&&!/^(IFRAME|FRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT)$/.test(n.tagName||'')&&!n.closest?.(forbidden);}
function modal(w){return Array.from(w.document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[open]')).slice(0,20).some(n=>{if(n.matches?.('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[open]')!==true)return false;const r=n.getBoundingClientRect?.(),s=w.getComputedStyle?.(n);return n.isConnected!==false&&r&&r.width>0&&r.height>0&&r.bottom>0&&r.top<w.innerHeight&&r.right>0&&r.left<w.innerWidth&&s?.display!=='none'&&s?.visibility!=='hidden'&&Number(s?.opacity??1)>0&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;});}
function valid(w,n){
 if(!allowed(w,n)||modal(w)||n.clientHeight<100||!Number.isFinite(n.scrollHeight))return false;
 const s=w.getComputedStyle?.(n);if(s&&(/^(hidden|clip)$/.test(s.overflowY)||s.display==='none'||s.visibility==='hidden'))return false;
 if(n===w.document.scrollingElement)return true;
 const r=n.getBoundingClientRect?.();return !!r&&r.width>=100&&r.height>=100&&r.bottom>0&&r.top<w.innerHeight&&r.right>0&&r.left<w.innerWidth&&r.right>0&&r.left<w.innerWidth&&/^(auto|scroll|overlay)$/.test(s?.overflowY||'');
}
function position(w,n){return n===w.document.scrollingElement?Math.max(Number(w.scrollY)||0,Number(n.scrollTop)||0):Number(n.scrollTop)||0;}
function start(w,limitMs=15000){
 let touch=null,finished=false,timer,resolve;const stats={touches:0,rejected:0,anchored:0};
 const reject=()=>{stats.rejected=Math.min(20,stats.rejected+1);};
 const promise=new Promise(r=>{resolve=r;});
 const options={capture:true,passive:true};
 const stop=(target=null)=>{if(finished)return;finished=true;w.clearTimeout(timer);for(const [type,fn] of listeners)w.document.removeEventListener(type,fn,options);touch=null;resolve({target,stats:{...stats}});};
 function begin(e){
  touch=null;if(e.isTrusted!==true||e.touches?.length!==1||!allowed(w,e.target)||modal(w)){reject();return;}
  const t=e.touches[0];if(!Number.isFinite(t.clientY)||!Number.isSafeInteger(t.identifier)){reject();return;}
  stats.touches=Math.min(20,stats.touches+1);const chain=[];let p=e.target;
  for(let i=0;p&&i<64;i++,p=p.parentElement)if(allowed(w,p))chain.push({node:p,before:position(w,p)});
  const root=w.document.scrollingElement;if(allowed(w,root)&&!chain.some(x=>x.node===root))chain.push({node:root,before:position(w,root)});
  touch={id:t.identifier,y:t.clientY,travel:0,chain,seen:new Set()};
 }
 function choose(){if(!touch||touch.travel<12)return;for(const p of touch.chain)if(touch.seen.has(p.node)&&position(w,p.node)>p.before+2){if(valid(w,p.node)){stats.anchored=1;stop(p.node);return;}reject();}}
 function move(e){if(!touch)return;if(e.isTrusted!==true||e.touches?.length!==1){touch=null;reject();return;}const t=e.touches[0];if(t.identifier!==touch.id||!Number.isFinite(t.clientY)){touch=null;reject();return;}touch.travel=Math.max(touch.travel,touch.y-t.clientY);choose();}
 function scroll(e){if(!touch||e.isTrusted!==true)return;if(touch.expires&&w.performance.now()>touch.expires){touch=null;return;}const n=e.target===w.document?w.document.scrollingElement:e.target;if(touch.chain.some(x=>x.node===n))touch.seen.add(n);choose();}
 function end(e){if(!touch||e.isTrusted!==true)return;if(e.isTrusted===true){const t=Array.from(e.changedTouches||[]).find(t=>t.identifier===touch.id);if(t&&Number.isFinite(t.clientY)){touch.travel=Math.max(touch.travel,touch.y-t.clientY);choose();}}if(touch){if(touch.travel>=12)touch.expires=w.performance.now()+1000;else touch=null;}}
 function cancel(e){end(e);}
 const listeners=[['touchstart',begin],['touchmove',move],['touchend',end],['touchcancel',cancel],['scroll',scroll]];
 for(const [type,fn] of listeners)w.document.addEventListener(type,fn,options);
 timer=w.setTimeout(()=>stop(),Math.max(0,Math.min(15000,Number(limitMs)||0)));
 return {promise,stop,valid:n=>valid(w,n)};
}
const api={start,valid};if(typeof module!=='undefined')module.exports=api;root.FlipDesktopGesture=api;
})(globalThis);
