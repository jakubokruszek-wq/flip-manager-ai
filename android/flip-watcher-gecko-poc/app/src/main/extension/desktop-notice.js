/* Ordinary Close action for Mozilla bug 1926869's notification notice, never a permission grant. */
(function(root){'use strict';
const selector='[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[open]';
const names=new Set(['push notifications request','prośba o powiadomienia push','żądanie powiadomień push','prośba o włączenie powiadomień']);
const normalize=s=>typeof s==='string'&&s.length<=128?s.trim().replace(/\s+/g,' ').toLowerCase():'';
function visible(w,n){
 if(!n||n.ownerDocument!==w.document||n.isConnected!==true)return false;
 const r=n.getBoundingClientRect(),s=w.getComputedStyle(n);
 return r.width>0&&r.height>0&&r.bottom>0&&r.top<w.innerHeight&&r.right>0&&r.left<w.innerWidth&&s.display!=='none'&&!/hidden|collapse/.test(s.visibility)&&Number(s.opacity)>0&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;
}
function inspect(w){
 const nodes=Array.from(w.document.querySelectorAll(selector));
 if(nodes.length>20)return {blocked:true,known:false};
 const shown=nodes.filter(n=>visible(w,n));
 if(!shown.length)return {blocked:false,known:false};
 const known=shown.filter(n=>n.getAttribute('role')==='alertdialog'&&n.getAttribute('aria-modal')==='true'&&names.has(normalize(n.getAttribute('aria-label'))));
 if(shown.length!==1||known.length!==1)return {blocked:true,known:known.length>0};
 const dialog=known[0];
 if(dialog.closest('article,[role="article"],[role="feed"],form,[inert]')||dialog.querySelector('form,input,textarea,select,iframe,frame,object,embed,a[href],[contenteditable="true"],[inert]')||dialog.querySelectorAll('*').length>200)return {blocked:true,known:true};
 const buttons=Array.from(dialog.querySelectorAll('button'));
 if(buttons.length!==1)return {blocked:true,known:true};
 const button=buttons[0];
 if(!['close','zamknij'].includes(normalize(button.textContent))||button.disabled||button.form||button.hasAttribute('formaction')||!visible(w,button)||w.getComputedStyle(button).pointerEvents==='none')return {blocked:true,known:true};
 const r=button.getBoundingClientRect(),hit=w.document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
 if(!hit||!(hit===button||button.contains(hit)))return {blocked:true,known:true};
 return {blocked:true,known:true,button};
}
async function dismiss(w,{safe,pause,deadline,onKnown=()=>{}}){
 const result=(status,detected=0,closed=0)=>({status,detected,closed});
 if(!safe())return result('CONTEXT');
 let found=inspect(w);if(!found.blocked)return result('CLEAR');
 const detected=Number(found.known);
 if(!found.button||w.performance.now()>=deadline)return result('BLOCKED',detected);
 onKnown();if(!safe())return result('CONTEXT',detected);
 const checked=inspect(w);if(checked.button!==found.button)return result('BLOCKED',detected);
 // Normal DOM button click, once. Do not remove nodes, alter CSS, grant permissions or forge trusted input.
 found.button.click();found=null;
 const end=Math.min(deadline,w.performance.now()+1500);
 while(safe()&&w.performance.now()<end){
  const state=inspect(w);if(!state.blocked)return result('CLOSED',1,1);
  if(!state.known)return result('BLOCKED',1);
  await pause(Math.min(50,end-w.performance.now()));
 }
 return result(safe()?'BLOCKED':'CONTEXT',1);
}
function watch(w,stop){
 if(typeof w.MutationObserver!=='function')return ()=>{};
 let closed=false;const finish=()=>{if(closed)return;closed=true;observer.disconnect();};
 const check=()=>{if(!closed&&inspect(w).blocked){finish();stop();}};
 const observer=new w.MutationObserver(check);
 observer.observe(w.document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['role','aria-modal','style','class','hidden','open']});
 check();return finish;
}
const api={inspect,dismiss,watch,selector};if(typeof module!=='undefined')module.exports=api;root.FlipDesktopNotice=api;
})(globalThis);
