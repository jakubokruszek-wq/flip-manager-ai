/* Opt-in response diagnostic. No body, record, URL or ID ever leaves this module. */
(function(scope) {
  "use strict";
  const keys = ["responseLoadMode","responseLoadNavigation","responseLoadVerified","responseQueuedBodies","responseTabFetch","responseTabOther","responseTabUnhandled","responseAutoScroll","responseScrollSteps","responseScrollMoves","responseObserved","responseBoundTab","responseOtherTab","responseNoTab","responseTabXhr","responseFrameRejected","responseHostRejected","responseEndpointRejected","responseMissingOrigin","responseApiAvailable","responseArmed","responseRequestsSeen","responseOriginRejected","responseFiltered","responseCompleted","responseBytes","responseOversize","responseDecodeErrors","responseStreamErrors","responseLimitSkipped","responseKeyPostId","responseKeyStoryId","responseExactIds","responseDuplicateIds","responseRecordsWithText","responseRecordsWithAuthor","responseRecordsWithImages","responsePriceSignals","responseAreaSignals","responseStopped","responseTypeDocument","responseTypeSubFrame","responseTypeScript","responseTypeImage","responseTypeImageSet","responseTypeStylesheet","responseTypeFont","responseTypeMedia","responseTypePing","responseTypeBeacon","responseTypeWebsocket","responseTypeObject","responseTypeObjectSubrequest","responseTypeCspReport","responseTypeSpeculative","responseTypeManifest","responseTypeXslt","responseTypeUnknown","responseDataEndpoints","responseDataXhr","responseDataFetch","responseDataOther","responseDataPing","responseDataBeacon","responseDataUnhandled","responseDataEligiblePing","responseDataEligibleBeacon","responseDataEligibleUnhandled","responseDataFrameRejected","responseDataOriginRejected","responseDataMissingOrigin","responseAjaxBz","responseAjaxOther","responseDataPath","responseBeaconRead","responseBeaconFiltered","responseBeaconCompleted","responseBeaconBytes","responseBeaconNoData"];
  const MAX_BODY=524288, MAX_TOTAL=2097152;
  function groupURL(raw, group, fixture) {
    try { const u=new URL(raw); return /^[A-Za-z0-9._-]{1,100}$/.test(group) && !u.username && !u.password && !u.hash &&
      (fixture || !u.search) && ((u.protocol==="https:" && !u.port && ["facebook.com","www.facebook.com","m.facebook.com"].includes(u.hostname)) || (fixture && u.protocol==="http:" && u.hostname==="127.0.0.1")) && u.pathname.replace(/\/$/,"") === "/groups/"+group; } catch {return false;}
  }
  function create(api, core, timers=scope) {
    let current=null, listenerReady=false;const revoked=new Set();
    const now=()=>timers.performance?.now?.() ?? Date.now();
    const available=()=>listenerReady && typeof api?.webRequest?.filterResponseData==="function";
    const fresh=(stopped=false)=>Object.fromEntries(keys.map(k=>[k,k==="responseStopped"?Number(stopped):k==="responseApiAvailable" && available()?1:0]));
    const inc=(s,key,n=1)=>{s.counts[key]=Math.min(2000,s.counts[key]+n);};
    function discard(stream) {stream.parts.length=0;stream.decoder=null;try{stream.filter.disconnect();}catch{} }
    function release(s) {s.closed=true;timers.clearTimeout(s.timer);for(const stream of s.streams.values()) discard(stream);s.streams.clear();s.ids.clear();s.pending.length=0;}
    function abort() {if(current){const s=current;current=null;release(s);}}
    function senderOK(sender,m) {return m?.consent===true && Number.isInteger(sender?.tab?.id) && sender.tab.id>=0 && sender.frameId===0 && groupURL(sender.url,m.groupId,m.fixture===true);}
    function arm(m,sender) {
      if(!senderOK(sender,m) || typeof m.nonce!=="string" || !/^[A-Za-z0-9-]{8,64}$/.test(m.nonce)) return {status:"STOP",counts:fresh(true)};
      if(revoked.has(m.nonce))return {status:"STOP",counts:fresh(true)};
      if(!available()) return {status:"UNSUPPORTED",counts:fresh()};
      if(current) return {status:"BUSY",counts:fresh()};
      const s={nonce:m.nonce,tab:sender.tab.id,group:m.groupId,fixture:m.fixture===true,counts:fresh(),streams:new Map(),ids:new Set(),pending:[],load:m.reloadConsent===true,beaconConsent:m.reloadConsent===true && m.beaconConsent===true,target:sender.url,navigated:false,verified:false,scrollConsent:m.reloadConsent===true && m.autoScrollConsent===true,deadline:now()+Math.max(500,Math.min(m.reloadConsent===true?25000:15000,Number(m.windowMs)||15000)),closed:false,expired:false};
      s.counts.responseBeaconRead=s.beaconConsent?1:0;s.counts.responseArmed=1;s.counts.responseLoadMode=s.load?1:0;s.counts.responseAutoScroll=s.scrollConsent?1:0;current=s;
      s.timer=timers.setTimeout(()=>{if(current!==s)return;for(const stream of s.streams.values())discard(stream);s.streams.clear();s.ids.clear();s.pending.length=0;s.expired=true;},Math.max(500,Math.min(s.load?25000:15000,Number(m.windowMs)||15000)));
      return {status:"ARMED",counts:{...s.counts}};
    }
    function read(m,sender) {
      const s=current;
      if(!s || s.load || m.nonce!==s.nonce || sender?.tab?.id!==s.tab || sender.frameId!==0) return {status:"STOP",counts:fresh(true)};
      if(!senderOK({...sender}, {...m,consent:true,groupId:s.group,fixture:s.fixture})){abort();return {status:"STOP",counts:fresh(true)};}
      const counts={...s.counts};current=null;release(s);return {status:"OK",counts};
    }
    function abortLoad(m) {
      if(typeof m?.nonce!=="string" || !/^[A-Za-z0-9-]{8,64}$/.test(m.nonce))return;
      revoked.add(m.nonce);while(revoked.size>32)revoked.delete(revoked.values().next().value);
      if(current?.load && current.nonce===m.nonce)abort();
    }
    function loadContext(sender) {
      const s=current;
      if(!s || !s.load || !s.navigated || s.closed || s.expired || now()>=s.deadline || sender?.tab?.id!==s.tab || !senderOK(sender,{consent:true,groupId:s.group,fixture:s.fixture}))return {active:false};
      return {active:true,nonce:s.nonce,groupId:s.group,fixture:s.fixture,autoScrollConsent:s.scrollConsent,remainingMs:Math.max(0,Math.ceil(s.deadline-now()))};
    }
    function confirmLoad(m,sender) {
      const s=current;if(!loadContext(sender).active || m.nonce!==s.nonce || m.safe!==true){if(s && sender?.tab?.id===s.tab)abort();return false;}
      s.verified=true;s.counts.responseLoadVerified=1;
      const pending=s.pending.splice(0);for(const body of pending){if(current!==s)break;parse(s,body);}return current===s;
    }
    function recordLoadScroll(m,sender) {
      const s=current;
      if(!loadContext(sender).active || !s.verified || !s.scrollConsent || m.nonce!==s.nonce ||
        !Number.isInteger(m.step) || m.step!==s.counts.responseScrollSteps+1 || m.step>5 || typeof m.moved!=="boolean")return false;
      s.counts.responseScrollSteps=m.step;if(m.moved)s.counts.responseScrollMoves++;return true;
    }
    // Privileged native port only; a content script cannot invoke this route.
    function readLoad(m) {
      const s=current;if(!s || !s.load || m.nonce!==s.nonce)return {status:"STOP",counts:fresh(true)};
      if(!s.navigated || !s.verified){abort();return {status:"STOP",counts:fresh(true)};}
      const counts={...s.counts};current=null;release(s);return {status:"OK",counts};
    }
    function receive(s,body) {
      if(/captcha_response|id=["']login_form|\/checkpoint\//i.test(body)){abort();return;}
      if(s.load && !s.verified){if(!s.expired && current===s){s.pending.push(body);inc(s,"responseQueuedBodies");}return;}
      parse(s,body);
    }
    // The desktop parser may supply a missing group from its source context.
    // Independently require an explicit group URL in a structured link field
    // before accepting its canonicalized result. No bare/profile IDs promoted.
    function explicitIds(body,group) {
      const ids=new Set();let seen=0;
      for(const match of body.matchAll(/"(?:permalink|permalink_url|url)"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
        if(++seen>400)break;if(match[1].length>4096)continue;
        try {
          const u=new URL(JSON.parse(match[1]),"https://www.facebook.com");
          if(u.protocol!=="https:" || u.port || u.username || u.password || !["facebook.com","www.facebook.com","m.facebook.com"].includes(u.hostname))continue;
          const g=u.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d{5,30})\/?$/);
          if(!(g?.[1]===group || (u.pathname==="/story.php" && u.searchParams.get("id")===group)))continue;
          const link=core.parsePostLink(u.href);if(link && (!g || link.postId===g[2]))ids.add(link.postId);
          if(ids.size>=20)break;
        }catch{}
      }
      return ids;
    }
    function parse(s,body) {
      if(current!==s || s.closed || s.expired || now()>=s.deadline) return;
      // Conservative STOP on response-level verification pages, before parsing posts.
      if (/captcha_response|id=["']login_form|\/checkpoint\//i.test(body)){abort();return;}
      inc(s,"responseKeyPostId",Math.min(2000,(body.match(/"post_id"\s*:/g)||[]).length));
      inc(s,"responseKeyStoryId",Math.min(2000,(body.match(/"(?:top_level_post_id|story_fbid)"\s*:/g)||[]).length));
      const source={sourceType:"GROUP",sourceId:s.group,sourceUrl:"https://www.facebook.com/groups/"+s.group+"/",allowGroupRedirect:false};
      const explicit=explicitIds(body,s.group);
      let records=[];
      try {records=core.extractStructuredRecordsFromText(body,"NETWORK",source,0)||[];}catch{inc(s,"responseDecodeErrors");return;}
      for(const r of records.slice(0,100)) {
        if(!explicit.has(r.postId) || !/^\d{5,30}$/.test(r.postId) || r.sourceType!=="GROUP" || r.sourceId!==s.group || core.parsePostLink(r.permalink,source)?.postId!==r.postId) continue;
        if(s.ids.has(r.postId)){inc(s,"responseDuplicateIds");continue;}
        if(s.ids.size>=20){inc(s,"responseLimitSkipped");continue;}
        s.ids.add(r.postId);s.counts.responseExactIds=s.ids.size;
        const text=typeof r.text==="string"?r.text.slice(0,12000):"";
        if(text)inc(s,"responseRecordsWithText");if(r.author)inc(s,"responseRecordsWithAuthor");if(r.media?.length)inc(s,"responseRecordsWithImages");
        if(/\d[\d .,]*\s*(?:zł|PLN)(?![a-zA-Ząćęłńóśźż])/i.test(text))inc(s,"responsePriceSignals");
        if(/\d+(?:[,.]\d+)?\s*m(?:²|2)(?!\w)/i.test(text))inc(s,"responseAreaSignals");
      }
    }
    function allowedHost(u,s) {
      return (u.protocol==="https:" && !u.port && ["facebook.com","www.facebook.com","m.facebook.com"].includes(u.hostname)) || (s.fixture && u.protocol==="http:" && u.hostname==="127.0.0.1");
    }
    const allowedPath=p=>/^\/ajax\//.test(p) || /^\/api\/graphql\/?$/.test(p) || /^\/graphql\/?$/.test(p);
    const typeKeys=Object.freeze({"main_frame":"responseTypeDocument","sub_frame":"responseTypeSubFrame","script":"responseTypeScript","image":"responseTypeImage","imageset":"responseTypeImageSet","stylesheet":"responseTypeStylesheet","font":"responseTypeFont","media":"responseTypeMedia","ping":"responseTypePing","beacon":"responseTypeBeacon","websocket":"responseTypeWebsocket","object":"responseTypeObject","object_subrequest":"responseTypeObjectSubrequest","csp_report":"responseTypeCspReport","speculative":"responseTypeSpeculative","web_manifest":"responseTypeManifest","xslt":"responseTypeXslt"});
    // Passive classification only. It NEVER instantiates a body filter or stores URLs/types.
    function classifyTransport(s,d) {
      if(!["xmlhttprequest","fetch","other"].includes(d.type))inc(s,Object.prototype.hasOwnProperty.call(typeKeys,d.type)?typeKeys[d.type]:"responseTypeUnknown");
      let u;try{u=new URL(d.url);}catch{return;}
      if(!allowedHost(u,s))return;
      const bz=/^\/ajax\/bz(?:\/|$)/.test(u.pathname);
      const ajax=/^\/ajax(?:\/|$)/.test(u.pathname);
      const data=/^\/data(?:\/|$)/.test(u.pathname);
      if(!ajax && !data && !allowedPath(u.pathname))return;
      inc(s,"responseDataEndpoints");
      if(bz)inc(s,"responseAjaxBz");else if(ajax)inc(s,"responseAjaxOther");
      if(data)inc(s,"responseDataPath");
      const kind={xmlhttprequest:"Xhr",fetch:"Fetch",other:"Other",ping:"Ping",beacon:"Beacon"};
      const suffix=Object.prototype.hasOwnProperty.call(kind,d.type)?kind[d.type]:"Unhandled";
      inc(s,"responseData"+suffix);
      if(d.frameId!==0){inc(s,"responseDataFrameRejected");return;}
      if(!groupURL(d.documentUrl || d.originUrl,s.group,s.fixture)){
        if(!d.documentUrl && !d.originUrl)inc(s,"responseDataMissingOrigin");inc(s,"responseDataOriginRejected");return;
      }
      // Coarse /data is diagnostic-only; eligibility still uses the UNCHANGED body path gate.
      if(allowedPath(u.pathname) && ["Ping","Beacon","Unhandled"].includes(suffix))inc(s,"responseDataEligible"+suffix);
    }
    // Separate PASSIVE listener: see events before the body listener's gates.
    // Only bounded counts; no addresses, IDs, headers or content retained.
    function observe(d) {
      const s=current;if(!s || s.closed || s.expired || now()>=s.deadline)return;
      inc(s,"responseObserved");
      if(!Number.isInteger(d.tabId) || d.tabId<0){inc(s,"responseNoTab");return;}
      if(d.tabId!==s.tab){inc(s,"responseOtherTab");return;}
      inc(s,"responseBoundTab");
      classifyTransport(s,d);
      if(d.type==="xmlhttprequest")inc(s,"responseTabXhr");
      else if(d.type==="fetch")inc(s,"responseTabFetch");
      else if(d.type==="other")inc(s,"responseTabOther");
      else if(d.type==="beacon" && s.beaconConsent){/* separately consented; fixed type counter already incremented */}
      else {inc(s,"responseTabUnhandled");return;}
      if(d.frameId!==0){inc(s,"responseFrameRejected");return;}
      let u;try{u=new URL(d.url);}catch{return;}
      if(!allowedHost(u,s)){inc(s,"responseHostRejected");return;}
      if(!allowedPath(u.pathname))inc(s,"responseEndpointRejected");
    }
    function before(d) {
      const s=current;if(!s || s.closed || s.expired || now()>=s.deadline || d.tabId!==s.tab) return;
      if(d.type==="main_frame"){
        if(s.load && !s.navigated && d.frameId===0 && d.url===s.target && groupURL(d.url,s.group,s.fixture)){
          s.navigated=true;s.counts.responseLoadNavigation=1;return;
        }
        abort();return;
      }
      if(s.load && !s.navigated)return;
      if(!(d.type==="xmlhttprequest" || (s.load && ["fetch","other"].includes(d.type)) || (s.beaconConsent && d.type==="beacon")) || d.frameId!==0)return;
      let u;try{u=new URL(d.url);}catch{return;}
      if(!allowedHost(u,s) || !allowedPath(u.pathname))return;
      inc(s,"responseRequestsSeen");
      if(!groupURL(d.documentUrl || d.originUrl,s.group,s.fixture)){if(!d.documentUrl && !d.originUrl)inc(s,"responseMissingOrigin");inc(s,"responseOriginRejected");return;}
      if(s.counts.responseFiltered>=8 || s.streams.size>=4 || s.counts.responseBytes>=MAX_TOTAL){inc(s,"responseLimitSkipped");return;}
      let filter;try{filter=api.webRequest.filterResponseData(d.requestId);}catch{inc(s,"responseStreamErrors");return;}
      const stream={beacon:d.type==="beacon",filter,parts:[],decoder:new TextDecoder("utf-8",{fatal:true}),bytes:0};s.streams.set(d.requestId,stream);inc(s,"responseFiltered");if(stream.beacon)inc(s,"responseBeaconFiltered");
      const drop=()=>{discard(stream);s.streams.delete(d.requestId);};
      filter.ondata=e=>{
        // Forward the original bytes FIRST, without any rewrite or re-encoding.
        try{filter.write(e.data);}catch{if(current===s)inc(s,"responseStreamErrors");drop();return;}
        if(current!==s || s.closed || s.expired || now()>=s.deadline){drop();return;}
        if(stream.bytes+e.data.byteLength>MAX_BODY || s.counts.responseBytes+e.data.byteLength>MAX_TOTAL){inc(s,"responseOversize");drop();return;}
        stream.bytes+=e.data.byteLength;s.counts.responseBytes+=e.data.byteLength;if(stream.beacon)s.counts.responseBeaconBytes+=e.data.byteLength;
        try{stream.parts.push(stream.decoder.decode(e.data,{stream:true}));}catch{inc(s,"responseDecodeErrors");drop();}
      };
      filter.onstop=()=>{
        try{filter.close();}catch{}s.streams.delete(d.requestId);
        if(current!==s || s.closed || s.expired || now()>=s.deadline || !stream.decoder){stream.parts.length=0;return;}
        let body="";try{body=stream.parts.join("")+stream.decoder.decode();}catch{inc(s,"responseDecodeErrors");}
        stream.parts.length=0;stream.decoder=null;inc(s,"responseCompleted");if(stream.beacon){inc(s,"responseBeaconCompleted");if(stream.bytes===0)inc(s,"responseBeaconNoData");}if(body)receive(s,body);
      };
      filter.onerror=()=>{if(current===s&&!s.closed)inc(s,"responseStreamErrors");drop();};
    }
    if(typeof api?.webRequest?.filterResponseData==="function") {
      try{
        api.webRequest.onBeforeRequest.addListener(observe,{urls:["https://*.facebook.com/*","https://facebook.com/*","https://*.fbcdn.net/*","http://127.0.0.1/*"]});
        api.webRequest.onBeforeRequest.addListener(before,{urls:["https://www.facebook.com/*","https://m.facebook.com/*","https://facebook.com/*","http://127.0.0.1/*"]},["blocking"]);
        listenerReady=true;
      }catch{}
    }
    return {arm,read,abort,before,observe,loadContext,confirmLoad,recordLoadScroll,readLoad,abortLoad,stop(m,sender){if(current && current.nonce===m.nonce && current.tab===sender?.tab?.id && sender.frameId===0)abort();}};
  }
  const exported={create,keys,groupURL};
  if(typeof module!=="undefined")module.exports=exported;
  if(scope.browser) {
    const diagnosis=create(scope.browser,scope.FlipFacebookCollectorCore);
    scope.FlipResponseDiagnosis=diagnosis;
    browser.runtime.onMessage.addListener((m,sender)=>{
      if(m?.type==="responseLoadContext")return Promise.resolve(diagnosis.loadContext(sender));
      if(m?.type==="recordResponseLoadScroll")return Promise.resolve({recorded:diagnosis.recordLoadScroll(m,sender)});
      if(m?.type==="confirmResponseLoad")return Promise.resolve({confirmed:diagnosis.confirmLoad(m,sender)});
      if(m?.type==="armResponse")return Promise.resolve(diagnosis.arm(m,sender));
      if(m?.type==="readResponse")return Promise.resolve(diagnosis.read(m,sender));
      if(m?.type==="stopResponse"){diagnosis.stop(m,sender);return Promise.resolve({stopped:true});}
      return undefined;
    });
  }
})(globalThis);
