/* Opt-in response diagnostic. No body, record, URL or ID ever leaves this module. */
(function(scope) {
  "use strict";
  const keys = ["responseApiAvailable","responseArmed","responseRequestsSeen","responseOriginRejected","responseFiltered","responseCompleted","responseBytes","responseOversize","responseDecodeErrors","responseStreamErrors","responseLimitSkipped","responseKeyPostId","responseKeyStoryId","responseExactIds","responseDuplicateIds","responseRecordsWithText","responseRecordsWithAuthor","responseRecordsWithImages","responsePriceSignals","responseAreaSignals","responseStopped"];
  const MAX_BODY=524288, MAX_TOTAL=2097152;
  function groupURL(raw, group, fixture) {
    try { const u=new URL(raw); return /^[A-Za-z0-9._-]{1,100}$/.test(group) && !u.username && !u.password && !u.hash &&
      (fixture || !u.search) && ((u.protocol==="https:" && !u.port && ["facebook.com","www.facebook.com","m.facebook.com"].includes(u.hostname)) || (fixture && u.protocol==="http:" && u.hostname==="127.0.0.1")) && u.pathname.replace(/\/$/,"") === "/groups/"+group; } catch {return false;}
  }
  function create(api, core, timers=scope) {
    let current=null, listenerReady=false;
    const available=()=>listenerReady && typeof api?.webRequest?.filterResponseData==="function";
    const fresh=(stopped=false)=>Object.fromEntries(keys.map(k=>[k,k==="responseStopped"?Number(stopped):k==="responseApiAvailable" && available()?1:0]));
    const inc=(s,key,n=1)=>{s.counts[key]=Math.min(2000,s.counts[key]+n);};
    function discard(stream) {stream.parts.length=0;stream.decoder=null;try{stream.filter.disconnect();}catch{} }
    function release(s) {s.closed=true;timers.clearTimeout(s.timer);for(const stream of s.streams.values()) discard(stream);s.streams.clear();s.ids.clear();}
    function abort() {if(current){const s=current;current=null;release(s);}}
    function senderOK(sender,m) {return m?.consent===true && Number.isInteger(sender?.tab?.id) && sender.tab.id>=0 && sender.frameId===0 && groupURL(sender.url,m.groupId,m.fixture===true);}
    function arm(m,sender) {
      if(!senderOK(sender,m) || typeof m.nonce!=="string" || !/^[A-Za-z0-9-]{8,64}$/.test(m.nonce)) return {status:"STOP",counts:fresh(true)};
      if(!available()) return {status:"UNSUPPORTED",counts:fresh()};
      if(current) return {status:"BUSY",counts:fresh()};
      const s={nonce:m.nonce,tab:sender.tab.id,group:m.groupId,fixture:m.fixture===true,counts:fresh(),streams:new Map(),ids:new Set(),closed:false,expired:false};
      s.counts.responseArmed=1;current=s;
      s.timer=timers.setTimeout(()=>{if(current!==s)return;for(const stream of s.streams.values())discard(stream);s.streams.clear();s.expired=true;},Math.max(500,Math.min(15000,Number(m.windowMs)||15000)));
      return {status:"ARMED",counts:{...s.counts}};
    }
    function read(m,sender) {
      const s=current;
      if(!s || m.nonce!==s.nonce || sender?.tab?.id!==s.tab) return {status:"STOP",counts:fresh(true)};
      if(!senderOK({...sender}, {...m,consent:true,groupId:s.group,fixture:s.fixture})){abort();return {status:"STOP",counts:fresh(true)};}
      const counts={...s.counts};current=null;release(s);return {status:"OK",counts};
    }
    function parse(s,body) {
      if(current!==s || s.closed || s.expired) return;
      // Conservative STOP on response-level verification pages, before parsing posts.
      if (/captcha_response|id=["']login_form|\/checkpoint\//i.test(body)){abort();return;}
      inc(s,"responseKeyPostId",Math.min(2000,(body.match(/"post_id"\s*:/g)||[]).length));
      inc(s,"responseKeyStoryId",Math.min(2000,(body.match(/"(?:top_level_post_id|story_fbid)"\s*:/g)||[]).length));
      const source={sourceType:"GROUP",sourceId:s.group,sourceUrl:"https://www.facebook.com/groups/"+s.group+"/",allowGroupRedirect:false};
      let records=[];
      try {records=core.extractStructuredRecordsFromText(body,"NETWORK",source,0)||[];}catch{inc(s,"responseDecodeErrors");return;}
      for(const r of records.slice(0,100)) {
        if(!/^\d{5,30}$/.test(r.postId) || r.sourceType!=="GROUP" || r.sourceId!==s.group || core.parsePostLink(r.permalink,source)?.postId!==r.postId) continue;
        if(s.ids.has(r.postId)){inc(s,"responseDuplicateIds");continue;}
        if(s.ids.size>=20){inc(s,"responseLimitSkipped");continue;}
        s.ids.add(r.postId);s.counts.responseExactIds=s.ids.size;
        const text=typeof r.text==="string"?r.text.slice(0,12000):"";
        if(text)inc(s,"responseRecordsWithText");if(r.author)inc(s,"responseRecordsWithAuthor");if(r.media?.length)inc(s,"responseRecordsWithImages");
        if(/\d[\d .,]*\s*(?:zł|PLN)(?![a-zA-Ząćęłńóśźż])/i.test(text))inc(s,"responsePriceSignals");
        if(/\d+(?:[,.]\d+)?\s*m(?:²|2)(?!\w)/i.test(text))inc(s,"responseAreaSignals");
      }
    }
    function before(d) {
      const s=current;if(!s || s.closed || s.expired || d.tabId!==s.tab) return;
      if(d.type==="main_frame"){abort();return;}
      if(d.type!=="xmlhttprequest" || d.frameId!==0) return;
      let u;try{u=new URL(d.url);}catch{return;}
      const host=(u.protocol==="https:" && !u.port && ["facebook.com","www.facebook.com","m.facebook.com"].includes(u.hostname)) || (s.fixture && u.protocol==="http:" && u.hostname==="127.0.0.1");
      if(!host || !(/^\/ajax\//.test(u.pathname) || /^\/api\/graphql\/?$/.test(u.pathname) || /^\/graphql\/?$/.test(u.pathname)))return;
      inc(s,"responseRequestsSeen");
      if(!groupURL(d.documentUrl || d.originUrl,s.group,s.fixture)){inc(s,"responseOriginRejected");return;}
      if(s.counts.responseFiltered>=8 || s.streams.size>=4 || s.counts.responseBytes>=MAX_TOTAL){inc(s,"responseLimitSkipped");return;}
      let filter;try{filter=api.webRequest.filterResponseData(d.requestId);}catch{inc(s,"responseStreamErrors");return;}
      const stream={filter,parts:[],decoder:new TextDecoder("utf-8",{fatal:true}),bytes:0};s.streams.set(d.requestId,stream);inc(s,"responseFiltered");
      const drop=()=>{discard(stream);s.streams.delete(d.requestId);};
      filter.ondata=e=>{
        // Forward the original bytes FIRST, without any rewrite or re-encoding.
        try{filter.write(e.data);}catch{if(current===s)inc(s,"responseStreamErrors");drop();return;}
        if(current!==s || s.closed || s.expired){drop();return;}
        if(stream.bytes+e.data.byteLength>MAX_BODY || s.counts.responseBytes+e.data.byteLength>MAX_TOTAL){inc(s,"responseOversize");drop();return;}
        stream.bytes+=e.data.byteLength;s.counts.responseBytes+=e.data.byteLength;
        try{stream.parts.push(stream.decoder.decode(e.data,{stream:true}));}catch{inc(s,"responseDecodeErrors");drop();}
      };
      filter.onstop=()=>{
        try{filter.close();}catch{}s.streams.delete(d.requestId);
        if(current!==s || s.closed || s.expired || !stream.decoder){stream.parts.length=0;return;}
        let body="";try{body=stream.parts.join("")+stream.decoder.decode();}catch{inc(s,"responseDecodeErrors");}
        stream.parts.length=0;stream.decoder=null;inc(s,"responseCompleted");if(body)parse(s,body);
      };
      filter.onerror=()=>{if(current===s&&!s.closed)inc(s,"responseStreamErrors");drop();};
    }
    if(typeof api?.webRequest?.filterResponseData==="function") {
      try{api.webRequest.onBeforeRequest.addListener(before,{urls:["https://www.facebook.com/*","https://m.facebook.com/*","https://facebook.com/*","http://127.0.0.1/*"]},["blocking"]);listenerReady=true;}catch{}
    }
    return {arm,read,abort,before,stop(m,sender){if(current && current.nonce===m.nonce && current.tab===sender?.tab?.id)abort();}};
  }
  const exported={create,keys,groupURL};
  if(typeof module!=="undefined")module.exports=exported;
  if(scope.browser) {
    const diagnosis=create(scope.browser,scope.FlipFacebookCollectorCore);
    scope.FlipResponseDiagnosis=diagnosis;
    browser.runtime.onMessage.addListener((m,sender)=>{
      if(m?.type==="armResponse")return Promise.resolve(diagnosis.arm(m,sender));
      if(m?.type==="readResponse")return Promise.resolve(diagnosis.read(m,sender));
      if(m?.type==="stopResponse"){diagnosis.stop(m,sender);return Promise.resolve({stopped:true});}
      return undefined;
    });
  }
})(globalThis);
