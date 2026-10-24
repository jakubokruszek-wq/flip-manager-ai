/* Ordinary Close for a narrowly recognized notification notice; never a permission grant. */
(function(root){'use strict';
const selector='[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[open]';
const names=new Set(['push notifications request','prośba o powiadomienia push','żądanie powiadomień push','prośba o włączenie powiadomień']);
const normalize=s=>typeof s==='string'&&s.length<=1024?s.trim().replace(/\s+/g,' ').toLowerCase():'';
const instruction='to allow or block browser notifications from facebook, go to your browser settings.';
const sensitive=/captcha|checkpoint|password|log[ -]?in|sign[ -]?in|verification|two.?factor|security|\bidentity\b|\bcode\b|logowani|zaloguj|hasł|weryfikacj|tożsamoś|\bkod(?:u|y)?\b/i;
// Fixed reasons only: 0 clear,1 unknown,2 multiple,3 unsafe,4 buttons,5 action,
// 6 visibility,7 covered,8 limit,9 replaced,10 ineffective,11 deadline,12 context.
function visible(w,n){
 if(!n||n.ownerDocument!==w.document||n.isConnected!==true)return false;
 const r=n.getBoundingClientRect(),s=w.getComputedStyle(n);
 return r.width>0&&r.height>0&&r.bottom>0&&r.top<w.innerHeight&&r.right>0&&r.left<w.innerWidth&&s.display!=='none'&&!/hidden|collapse/.test(s.visibility)&&Number(s.opacity)>0&&n.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;
}
function text(n,max=1024){
 let value='',seen=0;const stack=[n];
 while(stack.length){
  if(++seen>200)return null;const node=stack.pop();
  if(node.nodeType===3){const part=node.data??node.nodeValue;if(typeof part!=='string'||value.length+part.length>max)return null;value+=part+' ';}
  else if(node===n||node.nodeType===1){
   if(node.tagName==='BUTTON')continue;
   const children=node.childNodes||[];if(children.length+stack.length+seen>200)return null;
   for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
  }
 }
 return value.length<=max?value:null;
}
function accessible(w,n){
 const raw=n.getAttribute('aria-label')||'',by=n.getAttribute('aria-labelledby')||'';
 if(raw.length>128||by.length>160)return {name:'',source:0,invalid:true};
 if(by.trim()){
  const ids=by.trim().split(/\s+/);if(ids.length>2||ids.some(id=>id.length>80))return {name:'',source:0,invalid:true};
  const parts=[];
  for(const id of ids){
   const ref=w.document.getElementById?.(id);if(!ref)continue;
   if(ref.ownerDocument!==w.document||ref.isConnected!==true||!n.contains(ref))return {name:'',source:0,invalid:true};
   const part=text(ref,128);if(part===null)return {name:'',source:0,invalid:true};parts.push(part);
  }
  if(parts.length===ids.length&&normalize(parts.join(' ')))return {name:normalize(parts.join(' ')),source:2,invalid:false};
 }
 return {name:normalize(raw),source:raw?1:0,invalid:false};
}
function inspect(w){
 const nodes=Array.from(w.document.querySelectorAll(selector));const base={modals:Math.min(64,nodes.length),visible:0,source:0};
 const reject=(reason,known=false,source=0)=>({...base,blocked:true,known,reason,source});
 if(nodes.length>20)return reject(8);
 const shown=nodes.filter(n=>visible(w,n));base.visible=shown.length;
 if(!shown.length)return {...base,blocked:false,known:false,reason:0};
 if(shown.length!==1)return reject(2);
 const dialog=shown[0];
 // Never read a form or a post's content to classify a notice.
 if(dialog.closest('article,[role="article"],[role="feed"],form,[inert]')||dialog.querySelector('article,[role="article"],[role="feed"],form,input,textarea,select,iframe,frame,object,embed,a[href],[contenteditable="true"],[inert]')||dialog.querySelectorAll('*').length>200)return reject(3);
 const named=accessible(w,dialog),body=text(dialog);
 if(named.invalid||body===null)return reject(8);
 if(sensitive.test(named.name+' '+(dialog.getAttribute('aria-label')||'')+' '+body))return reject(3);
 // Standard accessible names and the exact published boilerplate, not a generic Close match.
 const canonical=names.has(named.name),message=normalize(body)===instruction;
 if(!canonical&&!message)return reject(1);
 const source=canonical?named.source:3;
 const buttons=Array.from(dialog.querySelectorAll('button'));
 if(buttons.length!==1)return reject(4,true,source);
 const button=buttons[0];
 if(!['close','zamknij'].includes(normalize(button.textContent))||button.disabled||button.form||button.hasAttribute('formaction'))return reject(5,true,source);
 if(!visible(w,button)||w.getComputedStyle(button).pointerEvents==='none')return reject(6,true,source);
 const r=button.getBoundingClientRect(),hit=w.document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
 if(!hit||!(hit===button||button.contains(hit)))return reject(7,true,source);
 return {...base,blocked:true,known:true,reason:0,source,button};
}
async function dismiss(w,{safe,pause,deadline,onKnown=()=>{}}){
 const result=(status,detected=0,closed=0,info={},reason=info.reason||0)=>({status,detected,closed,reason,modals:info.modals||0,visible:info.visible||0,source:info.source||0});
 if(!safe())return result('CONTEXT',0,0,{},12);
 let found=inspect(w);if(!found.blocked)return result('CLEAR',0,0,found);
 const detected=Number(found.known);
 if(!found.button)return result('BLOCKED',detected,0,found);
 if(w.performance.now()>=deadline)return result('BLOCKED',detected,0,found,11);
 onKnown();if(!safe())return result('CONTEXT',detected,0,found,12);
 const checked=inspect(w);if(checked.button!==found.button)return result('BLOCKED',detected,0,found,9);
 if(!safe())return result('CONTEXT',detected,0,found,12);
 if(w.performance.now()>=deadline)return result('BLOCKED',detected,0,found,11);
 const audit={modals:found.modals,visible:found.visible,source:found.source};
 // One ordinary DOM click. No CSS change, node removal, permission grant or trusted-input forgery.
 found.button.click();found=null;
 const end=Math.min(deadline,w.performance.now()+1500);
 while(safe()&&w.performance.now()<end){
  const state=inspect(w);if(!state.blocked)return result('CLOSED',1,1,audit,0);
  if(!state.known)return result('BLOCKED',1,0,audit,state.reason||1);
  await pause(Math.min(50,end-w.performance.now()));
 }
 return result(safe()?'BLOCKED':'CONTEXT',1,0,audit,safe()?10:12);
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
