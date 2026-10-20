/* DEBUG fixture experiment ONLY. Never matches or runs on Facebook. */
(function(s) {
  'use strict';
  const u=new URL(s.location.href), group=u.pathname.match(/^\/groups\/(\d+)\/$/)?.[1];
  if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || !group || u.searchParams.get('fixture')!=='main-world')return;
  const nonce=u.searchParams.get('labNonce')||'';
  if(!/^[a-f0-9-]{36}$/.test(nonce))return;
  const core=s.FlipFacebookCollectorCore;
  let armed=u.searchParams.get('labConsent')==='once', epoch=0, ids=new Set();
  const keys=['fetchIntact','xhrIntact','installed','beforePage','armed','fetchBodies','xhrBodies','bytes','exactIds','duplicates','textRecords','priceSignals','areaSignals','rejected','stopped'];
  let counts=Object.fromEntries(keys.map(k=>[k,0]));counts.installed=1;counts.armed=Number(armed);
  const emit=()=>{counts.fetchIntact=Number(s.document.documentElement?.dataset.fetchIntact==='true');counts.xhrIntact=Number(s.document.documentElement?.dataset.xhrIntact==='true');s.postMessage({channel:'MAIN_LAB_COUNTS',nonce,counts:{...counts}},u.origin);};
  function stop(){armed=false;epoch++;ids.clear();counts=Object.fromEntries(keys.map(k=>[k,0]));counts.installed=1;counts.stopped=1;emit();}
  function eligible(raw){try{const v=new URL(raw,u);return v.origin===u.origin && v.pathname==='/ajax/main-lab/' && v.searchParams.get('fixture')==='main-world-data';}catch{return false;}}
  function consume(body,kind,version){
    if(!armed || version!==epoch)return;
    const bytes=new TextEncoder().encode(body).byteLength;
    if(bytes>524288 || counts.bytes+bytes>1048576 || counts.fetchBodies+counts.xhrBodies>=4){counts.rejected++;emit();return;}
    counts.bytes+=bytes;counts[kind]++;
    const source={sourceType:'GROUP',sourceId:group,sourceUrl:`https://www.facebook.com/groups/${group}/`,allowGroupRedirect:false};
    for(const r of core.extractStructuredRecordsFromText(body,'NETWORK',source,0)||[]) {
      const exact=core.parsePostLink(r.permalink,source);
      if(!exact || !/^\d{5,30}$/.test(r.postId)||r.sourceId!==group||exact.postId!==r.postId)continue;
      // Fixture record still needs its literal exact group link, never a source-invented one.
      if(!body.includes(`https://www.facebook.com/groups/${group}/posts/${r.postId}/`))continue;
      if(ids.has(r.postId)){counts.duplicates++;continue;}
      if(ids.size>=20)continue;ids.add(r.postId);counts.exactIds=ids.size;
      const text=typeof r.text==='string'?r.text:'';
      if(text)counts.textRecords++;
      if(/\d[\d .,]*\s*(?:zł|PLN)/i.test(text))counts.priceSignals++;
      if(/\d+(?:[,.]\d+)?\s*m(?:²|2)/i.test(text))counts.areaSignals++;
    }
    emit();
  }
  const fetch=s.fetch;
  s.fetch=async function(...args){
    const version=epoch,read=armed&&eligible(typeof args[0]==='string'?args[0]:args[0]?.url);
    const response=await fetch.apply(this,args);
    if(read&&armed&&version===epoch) {
      // Bound stream before decoding; the page keeps the untouched original Response.
      const copy=response.clone();void (async()=>{const reader=copy.body?.getReader();if(!reader)return;const decoder=new TextDecoder('utf-8',{fatal:true});let body='',size=0;
        try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(!armed||version!==epoch||size>524288){await reader.cancel();return;}body+=decoder.decode(value,{stream:true});}body+=decoder.decode();consume(body,'fetchBodies',version);}catch{if(armed&&version===epoch){counts.rejected++;emit();}}})();
    }
    return response;
  };
  const X=s.XMLHttpRequest, open=X.prototype.open,send=X.prototype.send,requests=new WeakMap();
  X.prototype.open=function(method,url,...rest){requests.set(this,eligible(url));return open.call(this,method,url,...rest);};
  X.prototype.send=function(...args){const version=epoch;if(armed&&requests.get(this))this.addEventListener('load',()=>{if(armed&&version===epoch&&(!this.responseType||this.responseType==='text'))consume(this.responseText,'xhrBodies',version);},{once:true});return send.apply(this,args);};
  s.__mainLabInstalled=true;
  s.addEventListener('message',e=>{if(e.source!==s||e.origin!==u.origin||e.data?.channel!=='MAIN_LAB_COMMAND'||e.data.nonce!==nonce)return;if(e.data.op==='beforePage'){counts.beforePage=1;emit();}else if(e.data.op==='read')emit();else if(e.data.op==='stop')stop();});
  s.addEventListener('pagehide',stop,{once:true});
  s.document.addEventListener('visibilitychange',()=>{if(s.document.visibilityState!=='visible')stop();});
})(globalThis);
