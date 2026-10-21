/* Explicit native-consented context check. No post text, script, attribute values or network bodies. */
(function(root){
 'use strict';
 function allowed(raw,group,fixture){try{const u=new URL(raw);return !u.username&&!u.password&&!u.hash&&!u.search&&((u.protocol==='https:'&&!u.port&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))||(fixture===true&&u.protocol==='http:'&&u.hostname==='127.0.0.1'))&&(/^[A-Za-z0-9._-]{1,100}$/.test(group))&&(/^\/share\/p\/[A-Za-z0-9]{6,40}\/?$/.test(u.pathname)||new RegExp('^/groups/'+group.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(posts|permalink)/[0-9]{5,30}/?$').test(u.pathname));}catch{return false;}}
 function create(){let cleanup=null;return {stop(){if(cleanup)cleanup();cleanup=null;},check(w,m,send){
  this.stop();
  const safe=()=>m.consent===true&&typeof m.nonce==='string'&&/^[a-f0-9-]{36}$/.test(m.nonce)&&w.location.href===m.expectedUrl&&allowed(m.expectedUrl,m.groupId,m.fixture===true)&&w.document.visibilityState==='visible'&&!/log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość/i.test(w.document.title||'')&&!w.document.querySelector('input[type="password"],form[action*="login"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"],form[action*="checkpoint"]');
  // Navigation metadata only. An old port delivered late cannot prove a reload.
  const fresh=m.newDocumentAfter===undefined||(Number.isSafeInteger(m.newDocumentAfter)&&m.newDocumentAfter>=0&&typeof w.performance?.timeOrigin==='number'&&Number.isFinite(w.performance.timeOrigin)&&w.performance.timeOrigin>m.newDocumentAfter);
  const result={type:'shareLinkContextResult',nonce:m.nonce,safe:!!safe(),complete:w.document.readyState==='complete',fresh:!!fresh};
  if(!result.safe||!result.fresh)return result;
  let closed=false;const stop=()=>{if(closed)return;closed=true;observer.disconnect();w.clearInterval(timer);w.removeEventListener('pagehide',stop);w.document.removeEventListener('visibilitychange',check);};
  const check=()=>{if(closed)return;if(!safe()){stop();send({type:'shareLinkStop',nonce:m.nonce});}};
  const observer=new w.MutationObserver(check);observer.observe(w.document.documentElement,{subtree:true,childList:true,attributes:true});
  const timer=w.setInterval(check,100);w.addEventListener('pagehide',stop);w.document.addEventListener('visibilitychange',check);cleanup=stop;return result;
 }};}
 const api={create,allowed};if(typeof module!=='undefined')module.exports=api;root.FlipShareContext=api;
})(globalThis);
