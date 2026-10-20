/* Opt-in MAIN fetch/XHR transport. Bodies return ONLY through scripting API to extension background. */
(function(scope){
  'use strict';
  const keys=['installed','fetchBodies','xhrBodies','bytes','completed','exactIds','duplicates','textRecords','authorRecords','imageRecords','priceSignals','areaSignals','oversize','errors','limitSkipped','scrollSteps','scrollMoves'];
  const zero=()=>Object.fromEntries(keys.map(k=>[k,0]));
  // Serialized by the official scripting API: MUST NOT close over extension variables.
  async function capture(o){
    const g=globalThis,key='__flipMainStop_'+o.nonce;
    const fresh=()=>({installed:0,fetchBodies:0,xhrBodies:0,bytes:0,completed:0,oversize:0,errors:0,limitSkipped:0});
    const metrics=fresh(),bodies=[],readers=new Set();let closed=false,total=0,reserved=0,wake,unsubscribe=null;
    const done=new Promise(r=>{wake=r;});
    const same=()=>location.href===o.url&&document.visibilityState==='visible'&&!document.querySelector('input[type="password"],form[action*="login"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="checkpoint"]');
    const end=Date.now()+Math.max(0,Math.min(20000,o.expiresAt-Date.now()));
    const relay=g[Symbol.for('flip.main.transport.bootstrap')];
    if(!same()||end<=Date.now())return {status:'STOP',bodies:[],metrics:fresh()};
    if(relay?.version!==1||typeof relay.subscribe!=='function')return {status:'UNSUPPORTED',bodies:[],metrics:fresh()};
    const alive=()=>!closed&&Date.now()<end&&same();
    const stop=()=>{if(closed)return;closed=true;bodies.length=0;if(unsubscribe)unsubscribe();for(const r of readers)void r.cancel().catch(()=>{});readers.clear();wake('STOP');};
    Object.defineProperty(g,key,{value:{stop},configurable:true});
    const allowed=raw=>{try{const u=new URL(raw,location.href),base=new URL(o.url);return !u.username&&!u.password&&((u.protocol==='https:'&&!u.port&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))||(o.fixture===true&&u.origin===base.origin&&u.hostname==='127.0.0.1'))&&(/^\/ajax\//.test(u.pathname)||/^\/(?:api\/)?graphql\/?$/.test(u.pathname));}catch{return false;}};
    const inc=k=>{metrics[k]=Math.min(2000,metrics[k]+1);};
    function accept(body,kind,bytes){
      if(!alive()){stop();return;}
      if(/captcha_response|id=["']login_form|\/checkpoint\//i.test(body)){stop();return;}
      if(total+bytes>2097152){inc('oversize');return;}
      total+=bytes;metrics.bytes=total;metrics[kind]++;metrics.completed++;bodies.push(body);
    }
    const reserve=()=>{if(reserved>=8){inc('limitSkipped');return false;}reserved++;return true;};
    function observeFetch(response){
      if(!alive()||!allowed(response.url)||!reserve())return;
      try{const reader=response.clone().body?.getReader();if(!reader)return;readers.add(reader);
        void(async()=>{let body='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
          try{for(;;){const part=await reader.read();if(part.done)break;if(!alive()){stop();return;}bytes+=part.value.byteLength;if(bytes>524288||total+bytes>2097152){inc('oversize');await reader.cancel();return;}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();accept(body,'fetchBodies',bytes);}catch{if(alive())inc('errors');}finally{readers.delete(reader);}
        })();
      }catch{if(alive())inc('errors');}
    }
    function observeXHR(xhr){
      if(!alive()||!allowed(xhr.responseURL)||(xhr.responseType&&xhr.responseType!=='text')||!reserve())return;
      try{const body=xhr.responseText;if(body.length>524288){inc('oversize');return;}const bytes=new TextEncoder().encode(body).byteLength;if(bytes>524288){inc('oversize');return;}accept(body,'xhrBodies',bytes);}catch{if(alive())inc('errors');}
    }
    let timer,check;
    const stopIfUnsafe=()=>{if(document.visibilityState!=='visible')stop();};
    try{
      unsubscribe=relay.subscribe({acceptURL:raw=>alive()&&allowed(raw),fetch:observeFetch,xhr:observeXHR});
      metrics.installed=1;
      g.addEventListener('pagehide',stop);document.addEventListener('visibilitychange',stopIfUnsafe);
      check=setInterval(()=>{if(!same())stop();},100);
      timer=setTimeout(()=>{if(!same()){stop();return;}wake('OK');},Math.max(0,end-Date.now()));
      const status=await done;
      if(status!=='OK'||closed)return {status:'STOP',bodies:[],metrics:fresh()};
      return {status:'OK',bodies:bodies.splice(0),metrics:{...metrics}};
    }finally{
      closed=true;clearTimeout(timer);clearInterval(check);bodies.length=0;if(unsubscribe)unsubscribe();
      for(const r of readers)void r.cancel().catch(()=>{});readers.clear();
      g.removeEventListener('pagehide',stop);document.removeEventListener('visibilitychange',stopIfUnsafe);
      try{delete g[key];}catch{}
    }
  }
  function cancel(nonce){globalThis['__flipMainStop_'+nonce]?.stop();}
  function exactURL(raw,group,fixture){try{const u=new URL(raw);return !u.username&&!u.password&&!u.hash&&(fixture||!u.search)&&/^[A-Za-z0-9._-]{1,100}$/.test(group)&&u.pathname.replace(/\/$/,'')==='/groups/'+group&&((u.protocol==='https:'&&!u.port&&['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))||(fixture===true&&u.protocol==='http:'&&u.hostname==='127.0.0.1'));}catch{return false;}}
  function parseBodies(bodies,group,core){
    const c=zero(),ids=new Set();
    const source={sourceType:'GROUP',sourceId:group,sourceUrl:'https://www.facebook.com/groups/'+group+'/',allowGroupRedirect:false};
    for(const body of bodies){
      const explicit=new Set();let examined=0;
      for(const m of body.matchAll(/"(?:url|permalink|permalink_url)"\s*:\s*("(?:[^"\\]|\\.)*")/g)){
        if(++examined>400)break;if(m[1].length>4096)continue;
        try{const u=new URL(JSON.parse(m[1]),'https://www.facebook.com');if(u.protocol!=='https:'||u.port||u.username||u.password||!['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))continue;const p=u.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d{5,30})\/?$/);if(p?.[1]===group)explicit.add(p[2]);}catch{}
      }
      let records=[];try{records=core.extractStructuredRecordsFromText(body,'NETWORK',source,0)||[];}catch{c.errors++;}
      for(const r of records.slice(0,100)){
        if(!explicit.has(r.postId)||!/^\d{5,30}$/.test(r.postId)||r.sourceType!=='GROUP'||r.sourceId!==group||core.parsePostLink(r.permalink,source)?.postId!==r.postId)continue;
        if(ids.has(r.postId)){c.duplicates=Math.min(2000,c.duplicates+1);continue;}if(ids.size>=20){c.limitSkipped=Math.min(2000,c.limitSkipped+1);continue;}
        ids.add(r.postId);c.exactIds=ids.size;const text=typeof r.text==='string'?r.text.slice(0,12000):'';
        if(text)c.textRecords++;if(r.author)c.authorRecords++;if(r.media?.length)c.imageRecords++;
        if(/\d[\d .,]*\s*(?:zł|PLN)(?![a-zA-Ząćęłńóśźż])/i.test(text))c.priceSignals++;
        if(/\d+(?:[,.]\d+)?\s*m(?:²|2)(?!\w)/i.test(text))c.areaSignals++;
      }
    }
    ids.clear();return c;
  }
  function create(api,core,timers=scope){
    let active=null;
    const result=(status,counts=zero())=>({status,counts});
    const inject=(s,func,args)=>api.scripting.executeScript({target:{tabId:s.tab,frameIds:[0]},world:'MAIN',func,args});
    function abort(){const s=active;if(!s)return;active=null;s.closed=true;timers.clearTimeout(s.timer);s.reply=result('STOP');if(s.buffer)s.buffer.length=0;s.buffer=null;s.signal();void inject(s,cancel,[s.nonce]).catch(()=>{});}
    function valid(m,sender){return m?.consent===true&&/^[a-f0-9-]{36}$/.test(m.nonce)&&Number.isInteger(sender?.tab?.id)&&sender.tab.id>=0&&sender.frameId===0&&exactURL(sender.url,m.groupId,m.fixture===true);}
    function start(m,sender){
      if(!valid(m,sender))return result('STOP');
      if(active)return result('BUSY');
      if(typeof api?.scripting?.executeScript!=='function')return result('UNSUPPORTED');
      const wait=Math.max(1000,Math.min(20000,Number(m.windowMs)||20000));
      const s={tab:sender.tab.id,url:sender.url,nonce:m.nonce,group:m.groupId,fixture:m.fixture===true,closed:false,deadline:Date.now()+wait,reply:null,buffer:null};s.done=new Promise(r=>{s.signal=r;});active=s;
      s.timer=timers.setTimeout(()=>{if(active===s&&!s.reply)abort();},wait+2000);
      s.task=(async()=>{
        try{
          const response=await inject(s,capture,[{nonce:s.nonce,url:s.url,fixture:s.fixture,expiresAt:s.deadline}]);
          if(s.closed||active!==s)return;
          const r=response?.length===1&&response[0].frameId===0?response[0].result:null;
          if(Array.isArray(r?.bodies))s.buffer=r.bodies;
          const page=await api.tabs.get(s.tab);
          if(s.closed||active!==s)return;
          if(r?.status==='UNSUPPORTED'&&page.url===s.url){s.reply=result('UNSUPPORTED');timers.clearTimeout(s.timer);return;}
          if(page.url!==s.url||!exactURL(page.url,s.group,s.fixture)||!r||r.status!=='OK'||!Array.isArray(r.bodies)||r.bodies.length>8||r.bodies.some(b=>typeof b!=='string'||new TextEncoder().encode(b).byteLength>524288)||r.bodies.reduce((n,b)=>n+new TextEncoder().encode(b).byteLength,0)>2097152){abort();return;}
          const metricKeys=['installed','fetchBodies','xhrBodies','bytes','completed','oversize','errors','limitSkipped'];
          if(!r.metrics||Object.keys(r.metrics).length!==metricKeys.length||metricKeys.some(k=>!Number.isInteger(r.metrics[k])||r.metrics[k]<0||r.metrics[k]>(k==='bytes'?2097152:2000))||r.metrics.installed!==1||r.metrics.fetchBodies+r.metrics.xhrBodies!==r.metrics.completed||r.metrics.completed>8||r.metrics.completed!==r.bodies.length||r.metrics.bytes!==r.bodies.reduce((n,b)=>n+new TextEncoder().encode(b).byteLength,0)){abort();return;}
          const counts=parseBodies(r.bodies,s.group,core);r.bodies.length=0;
          for(const k of metricKeys)counts[k]=Math.min(k==='bytes'?2097152:2000,counts[k]+r.metrics[k]);
          s.reply=result('OK',counts);timers.clearTimeout(s.timer);
        }catch{if(active===s)abort();}finally{if(s.buffer)s.buffer.length=0;s.buffer=null;s.signal();}
      })();
      return {status:'ARMED'};
    }
    function context(m,sender){const s=active;return {active:!!(s&&!s.closed&&s.nonce===m.nonce&&s.tab===sender?.tab?.id&&sender.frameId===0&&sender.url===s.url&&Date.now()<s.deadline)};}
    async function read(m,sender){const s=active;if(!s||s.nonce!==m.nonce||sender?.tab?.id!==s.tab||sender.frameId!==0)return result('STOP');if(sender.url!==s.url){abort();return result('STOP');}await s.done;if(active!==s||s.closed)return result('STOP');const r=s.reply||result('STOP');active=null;timers.clearTimeout(s.timer);return r;}
    function stop(m,sender){if(active?.nonce===m.nonce&&active.tab===sender?.tab?.id)abort();}
    api?.webRequest?.onBeforeRequest?.addListener(d=>{if(active&&d.tabId===active.tab&&d.type==='main_frame')abort();},{urls:['https://*.facebook.com/*','https://facebook.com/*','http://127.0.0.1/*']});
    return {start,read,context,stop,abort};
  }
  const exported={capture,cancel,keys,zero,exactURL,parseBodies,create};
  if(typeof module!=='undefined')module.exports=exported;
  if(scope.browser){
    const transport=create(browser,scope.FlipFacebookCollectorCore);scope.FlipMainTransport=transport;
    browser.runtime.onMessage.addListener((m,sender)=>{
      if(m?.type==='startMainTransport')return Promise.resolve(transport.start(m,sender));
      if(m?.type==='readMainTransport')return transport.read(m,sender);
      if(m?.type==='mainTransportContext')return Promise.resolve(transport.context(m,sender));
      if(m?.type==='stopMainTransport'){transport.stop(m,sender);return Promise.resolve({stopped:true});}
      return undefined;
    });
  }
})(globalThis);
