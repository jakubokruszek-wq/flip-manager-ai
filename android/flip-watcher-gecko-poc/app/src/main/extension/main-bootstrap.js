/* document_start relay ONLY: never clones/reads responses. Private observers exist only during native-consented capture. */
(function(g){
  'use strict';
  const u=new URL(location.href),group=u.pathname.match(/^\/groups\/([^/]+)\/$/)?.[1];
  const real=u.protocol==='https:'&&!u.port&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname)&&group==='lodzsprzedazzakupwynajem';
  const fixture=u.protocol==='http:'&&u.hostname==='127.0.0.1'&&group==='1234567890123'&&u.searchParams.get('fixture')==='main-native';
  if(!real&&!fixture)return;
  const key=Symbol.for('flip.main.transport.bootstrap');if(g[key])return;
  let observer=null;let requests=new WeakMap();
  const originalFetch=g.fetch,X=g.XMLHttpRequest,originalOpen=X?.prototype.open,originalSend=X?.prototype.send;
  const permitted=(o,raw)=>{try{return o?.acceptURL(raw)===true;}catch{return false;}};
  const relayFetch=async function(...args){
    const current=observer;
    const allowed=current?permitted(current,typeof args[0]==='string'?args[0]:args[0]?.url):false;
    const response=await originalFetch.apply(this,args);
    if(allowed&&current===observer){try{current.fetch(response);}catch{}}
    return response;
  };
  const relayOpen=function(method,url,...args){
    const result=originalOpen.call(this,method,url,...args);
    const current=observer;requests.set(this,{current,allowed:current?permitted(current,url):false});
    return result;
  };
  const relaySend=function(...args){
    const entry=requests.get(this);requests.delete(this);
    if(entry?.allowed&&entry.current===observer)this.addEventListener('load',()=>{if(entry.current===observer){try{entry.current.xhr(this);}catch{}}},{once:true});
    return originalSend.apply(this,args);
  };
  g.fetch=relayFetch;if(X){X.prototype.open=relayOpen;X.prototype.send=relaySend;}
  // Registration alone grants no extension authority: page callbacks can only see their own page Responses.
  // The capture observer and its private result Promise are never exposed. There is no getObserver/arm/read API.
  Object.defineProperty(g,key,{value:Object.freeze({version:1,subscribe(candidate){
    if(!candidate||typeof candidate.acceptURL!=='function'||typeof candidate.fetch!=='function'||typeof candidate.xhr!=='function')throw Error('observer');
    observer=candidate;
    return ()=>{if(observer===candidate){observer=null;requests=new WeakMap();}};
  }}),configurable:false,writable:false});
})(globalThis);
