const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
require(path.resolve(__dirname,'../../../../../../extensions/facebook-collector/collector-core.js'));
const core=globalThis.FlipFacebookCollectorCore;
const {create,keys,groupURL}=require('../../main/extension/response-diagnosis.js');
const group='lodzsprzedazzakupwynajem',url=`https://www.facebook.com/groups/${group}/`;
const sender={tab:{id:7},frameId:0,url},msg={consent:true,nonce:'fresh-consent-123',groupId:group,windowMs:15000};
function harness(apiAvailable=true,fixture=false){
 const boundSender=fixture?{...sender,url:"http://127.0.0.1:1234/groups/"+group+"/?fixture=beacon"}:sender;
 const filters=[],timers=[];let clock=0;
 const api={webRequest:{onBeforeRequest:{addListener(fn){this.listener=fn;}}}};
 if(apiAvailable)api.webRequest.filterResponseData=id=>{const f={id,writes:[],write(b){this.writes.push(Buffer.from(b));},close(){this.closed=true;},disconnect(){this.disconnected=true;}};filters.push(f);return f;};
 const d=create(api,core,{performance:{now:()=>clock},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){}});
 const request=(extra={})=>{const details={tabId:7,frameId:0,type:'xmlhttprequest',url:'https://www.facebook.com/ajax/feed/',documentUrl:boundSender.url,requestId:String(filters.length),...extra};d.observe(details);return d.before(details);};
 const stream=(body,extra={})=>{request(extra);const f=filters.at(-1);const b=Buffer.from(body);for(let i=0;i<b.length;i+=7)f.ondata({data:Uint8Array.from(b.subarray(i,i+7)).buffer});f.onstop();return f;};
 return {d,filters,timers,request,stream,sender:boundSender,jump(ms){clock+=ms;},arm:(m=msg,s=boundSender)=>d.arm(m,s),read:(m=msg,s=boundSender)=>d.read(m,s)};
}
const story=(id='123456789',g=group)=>({__typename:'Story',post_id:id,permalink_url:`https://www.facebook.com/groups/${g}/posts/${id}/`,message:{text:'PRIVATE żółć 450 000 zł 54 m²'},actors:[{name:'PRIVATE_AUTHOR',id:'987654321'}]});
test('idle and absent consent never instantiate a response filter',()=>{const h=harness();h.request();assert.equal(h.filters.length,0);for(const consent of [false,undefined,'true'])assert.equal(h.arm({...msg,consent}).status,'STOP');h.request();assert.equal(h.filters.length,0);});
test('unsupported API fails closed and cannot start capture',()=>{const h=harness(false);assert.equal(h.arm().status,'UNSUPPORTED');h.request();assert.equal(h.filters.length,0);assert.equal(h.read().counts.responseApiAvailable,0);});
test('only exact group, top frame, trusted URL, new nonce and explicit consent arm',()=>{const h=harness();for(const s of [{...sender,frameId:1},{...sender,url:url+'?x=1'},{...sender,url:'https://evil.test/groups/'+group+'/'},{...sender,url:url.replace(group,'other')},{...sender,url:'https://user:pass@www.facebook.com/groups/'+group+'/'}])assert.equal(h.arm(msg,s).status,'STOP');assert.equal(h.arm({...msg,nonce:'bad'}).status,'STOP');assert.equal(h.arm().status,'ARMED');assert.equal(h.arm().status,'BUSY');assert.equal(h.timers[0].ms,15000);});
test('only same-tab top-frame XHR with approved document and allowed endpoint is filtered',()=>{const h=harness();h.arm();for(const x of [{tabId:8},{frameId:1},{type:'image'},{url:'https://fbcdn.net/ajax/feed/'},{url:'https://www.facebook.com/photo/'},{documentUrl:url.replace(group,'other')},{documentUrl:undefined}])h.request(x);assert.equal(h.filters.length,0);h.request();assert.equal(h.filters.length,1);const r=h.read();assert.equal(r.counts.responseOriginRejected,2);});
test('original UTF8 bytes reach the page unchanged; only counts are returned',()=>{const h=harness();h.arm();const body=JSON.stringify({node:story()});const f=h.stream(body);assert.equal(Buffer.concat(f.writes).toString(),body);assert.equal(f.closed,true);const r=h.read();assert.equal(r.status,'OK');assert.equal(r.counts.responseExactIds,1);assert.equal(r.counts.responseRecordsWithText,1);assert.equal(r.counts.responsePriceSignals,1);assert.equal(r.counts.responseAreaSignals,1);assert.deepEqual(Object.keys(r.counts),keys);assert(!JSON.stringify(r).includes('PRIVATE'));assert(!JSON.stringify(r).includes('123456789'));assert(!JSON.stringify(r).includes('facebook'));assert.equal(h.read().status,'STOP');});
test('exact IDs deduplicate while foreign, photo and bare IDs never become posts',()=>{const h=harness();h.arm();h.stream(JSON.stringify([story(),story(),story('222222222','other'),{post_id:'333333333'},{__typename:'Photo',id:'444444444',url:'https://www.facebook.com/photo/?fbid=444444444'}]));h.stream(JSON.stringify(story()));const c=h.read().counts;assert.equal(c.responseExactIds,1);assert.equal(c.responseDuplicateIds,1);});
test('wrong tab, nonce and frame cannot read or stop another session',()=>{const h=harness();h.arm();h.stream(JSON.stringify(story()));assert.equal(h.read({...msg,nonce:'wrong-consent'}).status,'STOP');assert.equal(h.read(msg,{...sender,tab:{id:8}}).status,'STOP');h.d.stop(msg,{...sender,tab:{id:8}});assert.equal(h.read(msg,{...sender,frameId:1}).status,'STOP');h.d.stop(msg,{...sender,frameId:1});assert.equal(h.read().counts.responseExactIds,1);});
test('page change aborts and releases all buffers; next consent starts clean',()=>{const h=harness();h.arm();h.request();const f=h.filters[0];f.ondata({data:Buffer.from('PRIVATE').buffer});h.request({type:'main_frame'});assert.equal(f.disconnected,true);assert.equal(h.read().status,'STOP');assert.equal(h.arm({...msg,nonce:'next-consent'}).status,'ARMED');assert.equal(h.read({...msg,nonce:'next-consent'}).counts.responseBytes,0);});
test('native abort, deadline and late callbacks never produce retained records',()=>{for(const action of ['abort','deadline']){const h=harness();h.arm();h.request();const f=h.filters[0];f.ondata({data:Uint8Array.from(Buffer.from(JSON.stringify(story()))).buffer});if(action==='abort')h.d.abort();else h.timers[0].fn();assert.equal(f.disconnected,true);f.onstop();assert.equal(h.read().counts.responseExactIds,0);h.request();assert.equal(h.filters.length,1);}});
test('per-body and total byte limits disconnect without changing original bytes',()=>{const h=harness();h.arm();h.request();let f=h.filters[0];const large=new Uint8Array(524289);f.ondata({data:large.buffer});assert.equal(f.disconnected,true);assert.equal(f.writes[0].length,large.length);assert.equal(h.read().counts.responseOversize,1);const t=harness();t.arm();for(let n=0;n<4;n++){t.request();const f=t.filters.at(-1);f.ondata({data:new Uint8Array(524288).fill(32).buffer});f.onstop();}t.request();assert.equal(t.filters.length,4);assert.equal(t.read().counts.responseBytes,2097152);});
test('concurrency, response count and unique post limits are enforced',()=>{const h=harness();h.arm();for(let i=0;i<5;i++)h.request();assert.equal(h.filters.length,4);h.filters.forEach(f=>f.onstop());for(let i=0;i<5;i++){h.request();h.filters.at(-1).onstop();}assert.equal(h.filters.length,8);const p=harness();p.arm();p.stream(JSON.stringify(Array.from({length:25},(_,i)=>story(String(123456780+i)))));assert.equal(p.read().counts.responseExactIds,20);});
test('invalid UTF8, stream errors and filter errors fail closed',()=>{const h=harness();h.arm();h.request();h.filters[0].ondata({data:Uint8Array.from([255]).buffer});assert.equal(h.filters[0].disconnected,true);h.request();h.filters[1].onerror();const c=h.read().counts;assert.equal(c.responseDecodeErrors,1);assert.equal(c.responseStreamErrors,1);assert.equal(c.responseExactIds,0);});
test('verification response clears all previous counts and aborts capture',()=>{for(const body of ['captcha_response','<form id="login_form">','/checkpoint/']){const h=harness();h.arm();h.stream(JSON.stringify(story()));h.stream(body);const r=h.read();assert.equal(r.status,'STOP');assert.equal(r.counts.responseExactIds,0);assert.equal(r.counts.responseStopped,1);}});
test('unsafe context on read clears session; fixture allowance never permits foreign hosts',()=>{const h=harness();h.arm();h.stream(JSON.stringify(story()));assert.equal(h.read(msg,{...sender,url:url.replace(group,'other')}).status,'STOP');assert.equal(h.read().counts.responseExactIds,0);assert(groupURL('http://127.0.0.1:1234/groups/'+group+'/?fixture=test',group,true));assert(!groupURL('http://evil.test/groups/'+group+'/',group,true));});

test('desktop source fallback cannot invent a group for profile or generic permalinks',()=>{const h=harness();h.arm();h.stream(JSON.stringify([{...story('123456789'),permalink_url:'https://www.facebook.com/profile/posts/123456789/'},{...story('223456789'),permalink_url:'https://www.facebook.com/posts/223456789/'},{...story('323456789'),permalink_url:'https://www.facebook.com/?fbid=323456789'}]));assert.equal(h.read().counts.responseExactIds,0);});
test('escaped JSON group links bind exactly; URLs inside message text do not bind',()=>{const h=harness();h.arm();h.stream(JSON.stringify(story()).replaceAll('/',String.raw`\/`));assert.equal(h.read().counts.responseExactIds,1);const p=harness();p.arm();p.stream(JSON.stringify({...story(),permalink_url:'https://www.facebook.com/posts/123456789/',message:JSON.stringify({url:'https://www.facebook.com/groups/'+group+'/posts/123456789/'})}));assert.equal(p.read().counts.responseExactIds,0);});

test('passive counters distinguish no-tab, other tab, type, frame, host and endpoint gates',()=>{
 const h=harness();h.arm();
 for(const x of [{tabId:-1},{tabId:8},{type:'image'},{frameId:2},{url:'https://graph.facebook.com/ajax/feed/'},{url:'https://www.facebook.com/not-approved/'},{documentUrl:undefined}])h.request(x);
 const c=h.read().counts;
 assert.equal(h.filters.length,0);assert.equal(c.responseObserved,7);assert.equal(c.responseNoTab,1);assert.equal(c.responseOtherTab,1);assert.equal(c.responseBoundTab,5);assert.equal(c.responseTabXhr,4);assert.equal(c.responseFrameRejected,1);assert.equal(c.responseHostRejected,1);assert.equal(c.responseEndpointRejected,1);assert.equal(c.responseMissingOrigin,1);assert.equal(c.responseOriginRejected,1);assert.equal(c.responseRequestsSeen,1);
});
test('passive observation never reads a body and is inactive without consent or after deadline',()=>{
 const h=harness();const d={tabId:7,frameId:0,type:'xmlhttprequest',url:'https://www.facebook.com/ajax/feed/'};
 h.d.observe(d);h.arm();h.d.observe(d);assert.equal(h.filters.length,0);h.timers[0].fn();h.d.observe(d);assert.equal(h.read().counts.responseObserved,1);h.d.observe(d);assert.equal(h.read().counts.responseObserved,0);
});
test('passive registration covers existing hosts; body listener retains its narrower URL scope',()=>{
 const regs=[];create({webRequest:{filterResponseData(){throw Error('must remain idle');},onBeforeRequest:{addListener(...args){regs.push(args);}}}},core,{setTimeout(){},clearTimeout(){}});
 assert.equal(regs.length,2);assert.equal(regs[0].length,2);assert(regs[0][1].urls.includes('https://*.fbcdn.net/*'));assert.deepEqual(regs[1][2],['blocking']);assert(!regs[1][1].urls.some(u=>u.includes('fbcdn') || u.includes('*.facebook')));
});
const loadMsg={...msg,reloadConsent:true,windowMs:25000};
const navigate=h=>h.request({type:'main_frame',url:h.sender.url});
const verify=h=>h.d.confirmLoad({nonce:msg.nonce,safe:true},h.sender);
test('controlled load buffers data until the new approved document is verified',()=>{
 const h=harness();h.arm(loadMsg);h.request({type:'other'});assert.equal(h.filters.length,0);
 navigate(h);h.stream(JSON.stringify(story()),{type:'other'});
 assert.equal(h.read().status,'STOP'); // content route cannot read privileged load
 assert.equal(h.d.loadContext({...sender,tab:{id:8}}).active,false);
 assert.equal(h.d.loadContext(sender).active,true);assert.equal(verify(h),true);
 const r=h.d.readLoad(msg);assert.equal(r.status,'OK');assert.equal(r.counts.responseLoadMode,1);assert.equal(r.counts.responseLoadNavigation,1);assert.equal(r.counts.responseLoadVerified,1);assert.equal(r.counts.responseQueuedBodies,1);assert.equal(r.counts.responseExactIds,1);assert(!JSON.stringify(r).includes('PRIVATE'));
});
test('only one exact same-tab main-frame is allowed; redirects and repeated loads stop',()=>{
 for(const change of [{url:url.replace(group,'other')},{url:url.replace('www.','m.')},{frameId:2}]){const h=harness();h.arm(loadMsg);h.request({type:'main_frame',url,...change});assert.equal(h.d.readLoad(msg).status,'STOP');}
 const h=harness();h.arm(loadMsg);navigate(h);navigate(h);assert.equal(h.d.readLoad(msg).status,'STOP');
});
test('fetch and other are load-only and retain all source, frame, host and path gates',()=>{
 for(const type of ['fetch','other']){const idle=harness();idle.arm();idle.request({type});assert.equal(idle.filters.length,0);
 const h=harness();h.arm(loadMsg);navigate(h);for(const bad of [{frameId:1},{url:'https://graph.facebook.com/ajax/feed/'},{url:'https://www.facebook.com/data/'},{documentUrl:undefined}])h.request({type,...bad});assert.equal(h.filters.length,0);
 h.stream(JSON.stringify(story()),{type});verify(h);assert.equal(h.d.readLoad(msg).counts.responseExactIds,1);}
});
test('unverified, unsafe and expired documents never expose parsed post counters',()=>{
 for(const action of ['read','unsafe','expire']){const h=harness();h.arm(loadMsg);navigate(h);h.stream(JSON.stringify(story()),{type:'other'});
 if(action==='unsafe')h.d.confirmLoad({nonce:msg.nonce,safe:false},sender);if(action==='expire')h.timers[0].fn();
 const r=h.d.readLoad(msg);assert.equal(r.status,'STOP');assert.equal(r.counts.responseExactIds,0);assert.equal(h.d.loadContext(sender).active,false);}
});
test('verification response aborts even before document confirmation',()=>{const h=harness();h.arm(loadMsg);navigate(h);h.stream('/checkpoint/',{type:'other'});assert.equal(h.d.loadContext(sender).active,false);assert.equal(h.d.readLoad(msg).status,'STOP');});
test('scoped cancellation revokes late arm and cannot cancel a later unrelated window',()=>{
 const h=harness();h.d.abortLoad(msg);assert.equal(h.arm(loadMsg).status,'STOP');
 const next={...msg,nonce:'second-fresh-consent'};assert.equal(h.arm(next).status,'ARMED');h.d.abortLoad(msg);assert.equal(h.read(next).status,'OK');
});
test('load timer is bounded to 25 seconds and cannot extend the old 15 second mode',()=>{const h=harness();h.arm({...loadMsg,windowMs:999999});assert.equal(h.timers[0].ms,25000);h.d.abort();h.arm({...msg,windowMs:999999});assert.equal(h.timers[1].ms,15000);});

test('load scroll context carries only strict fresh scroll consent and bounded remaining time',()=>{
 for(const value of [undefined,false,'true',true]){const h=harness();h.arm({...loadMsg,autoScrollConsent:value});navigate(h);const info=h.d.loadContext(sender);assert.equal(info.autoScrollConsent,value===true);assert(info.remainingMs>0 && info.remainingMs<=25000);assert(!JSON.stringify(info).includes('PRIVATE'));}
});
test('load scroll records need verified bound session, exact nonce and sequential boolean steps',()=>{
 const h=harness();h.arm({...loadMsg,autoScrollConsent:true});navigate(h);
 const step={nonce:msg.nonce,step:1,moved:true};assert.equal(h.d.recordLoadScroll(step,sender),false);verify(h);
 for(const bad of [{...step,nonce:'wrong-nonce'},{...step,step:2},{...step,step:1.5},{...step,moved:'true'}])assert.equal(h.d.recordLoadScroll(bad,sender),false);
 assert.equal(h.d.recordLoadScroll(step,{...sender,tab:{id:8}}),false);assert.equal(h.d.recordLoadScroll(step,{...sender,frameId:1}),false);
 assert.equal(h.d.recordLoadScroll(step,sender),true);assert.equal(h.d.recordLoadScroll(step,sender),false);
 for(let i=2;i<=5;i++)assert.equal(h.d.recordLoadScroll({...step,step:i,moved:i%2===0},sender),true);
 assert.equal(h.d.recordLoadScroll({...step,step:6},sender),false);
 const c=h.d.readLoad(msg).counts;assert.equal(c.responseAutoScroll,1);assert.equal(c.responseScrollSteps,5);assert.equal(c.responseScrollMoves,3);
});
test('ordinary load, expired or aborted windows reject scrolling',()=>{
 for(const action of ['no-consent','expire','abort']){const h=harness();h.arm({...loadMsg,autoScrollConsent:action==='no-consent'?false:true});navigate(h);verify(h);if(action==='expire')h.timers[0].fn();if(action==='abort')h.d.abort();assert.equal(h.d.recordLoadScroll({nonce:msg.nonce,step:1,moved:true},sender),false);}
});

test('monotonic expiry rejects delayed callbacks and scrolling even before timeout callback runs',()=>{
 const h=harness();h.arm({...loadMsg,autoScrollConsent:true});navigate(h);verify(h);h.request();const f=h.filters[0];h.jump(25001);
 assert.equal(h.d.loadContext(sender).active,false);assert.equal(h.d.recordLoadScroll({nonce:msg.nonce,step:1,moved:true},sender),false);
 f.ondata({data:Uint8Array.from(Buffer.from(JSON.stringify(story()))).buffer});f.onstop();h.request();const c=h.d.readLoad(msg).counts;
 assert.equal(h.filters.length,1);assert.equal(c.responseBytes,0);assert.equal(c.responseExactIds,0);assert.equal(c.responseScrollSteps,0);
});

test('unhandled resource types are partitioned exactly without reading any of their bodies',()=>{
 const types={main_frame:'Document',sub_frame:'SubFrame',script:'Script',image:'Image',imageset:'ImageSet',stylesheet:'Stylesheet',font:'Font',media:'Media',ping:'Ping',beacon:'Beacon',websocket:'Websocket',object:'Object',object_subrequest:'ObjectSubrequest',csp_report:'CspReport',speculative:'Speculative',web_manifest:'Manifest',xslt:'Xslt','not-a-browser-type':'Unknown'};
 const h=harness();h.arm();for(const [type,key] of Object.entries(types))h.d.observe({tabId:7,frameId:0,type,url:'https://www.facebook.com/ajax/bz/',documentUrl:url});
 const c=h.read().counts;for(const key of Object.values(types))assert.equal(c['responseType'+key],1);assert.equal(c.responseTabUnhandled,18);assert.equal(c.responseDataEndpoints,18);assert.equal(h.filters.length,0);
});
test('same-tab AJAX ping and beacon have eligible metadata but NEVER instantiate filters',()=>{
 const h=harness();h.arm(loadMsg);navigate(h);verify(h);
 for(const type of ['ping','beacon'])h.request({type,url:'https://www.facebook.com/ajax/bz/'});
 const c=h.d.readLoad(msg).counts;assert.equal(c.responseDataPing,1);assert.equal(c.responseDataBeacon,1);assert.equal(c.responseDataEligiblePing,1);assert.equal(c.responseDataEligibleBeacon,1);assert.equal(c.responseAjaxBz,2);assert.equal(c.responseFiltered,0);assert.equal(c.responseBytes,0);assert.equal(h.filters.length,0);
});
test('data endpoint classification excludes CDN, other tabs and no-tab events',()=>{
 const h=harness();h.arm();for(const x of [{tabId:8},{tabId:-1},{url:'https://fbcdn.net/ajax/bz/'}])h.request({type:'ping',...x});const c=h.read().counts;assert.equal(c.responseDataEndpoints,0);assert.equal(c.responseTypePing,1);assert.equal(h.filters.length,0);
});
test('metadata eligibility preserves frame and exact document origin checks',()=>{
 const h=harness();h.arm();for(const x of [{frameId:1},{documentUrl:undefined},{documentUrl:url.replace(group,'foreign')},{documentUrl:undefined,originUrl:url}])h.request({type:'ping',url:'https://www.facebook.com/ajax/bz/',...x});
 const c=h.read().counts;assert.equal(c.responseDataEndpoints,4);assert.equal(c.responseDataFrameRejected,1);assert.equal(c.responseDataOriginRejected,2);assert.equal(c.responseDataMissingOrigin,1);assert.equal(c.responseDataEligiblePing,1);assert.equal(h.filters.length,0);
});
test('coarse path buckets never retain queries or expand body endpoint scope',()=>{
 const h=harness();h.arm();for(const pathname of ['/ajax/bz/','/ajax/anything/','/data','/data/more/','/api/graphql','/graphql','/ajax/bzish/'])h.request({type:'ping',url:'https://www.facebook.com'+pathname+'?private=PRIVATE'});
 const c=h.read().counts;assert.equal(c.responseDataEndpoints,7);assert.equal(c.responseAjaxBz,1);assert.equal(c.responseAjaxOther,2);assert.equal(c.responseDataPath,2);assert.equal(c.responseDataEligiblePing,5);assert.equal(h.filters.length,0);assert(!JSON.stringify(c).includes('PRIVATE'));
 const d=harness();d.arm();d.request({url:'https://www.facebook.com/data/'});assert.equal(d.filters.length,0);assert.equal(d.read().counts.responseDataXhr,1);
});
test('passive type classification stops without consent, after deadline and after release',()=>{
 const h=harness();const d={tabId:7,frameId:0,type:'ping',url:'https://www.facebook.com/ajax/bz/',documentUrl:url};h.d.observe(d);h.arm();h.d.observe(d);h.jump(15001);h.d.observe(d);assert.equal(h.read().counts.responseTypePing,1);h.d.observe(d);assert.equal(h.read().counts.responseTypePing,0);
});

const beaconMsg={...loadMsg,fixture:true,beaconConsent:true};
test('Beacon body read is default OFF and needs strict new consent plus reload consent',()=>{
 for(const m of [msg,{...msg,beaconConsent:true},loadMsg,{...loadMsg,beaconConsent:'true'}]){const h=harness(true,true);h.arm(m);if(m.reloadConsent)navigate(h);h.request({type:'beacon'});assert.equal(h.filters.length,0);const c=(m.reloadConsent?(verify(h),h.d.readLoad(m)):h.read(m)).counts;assert.equal(c.responseBeaconRead,0);}
});
test('consented Beacon preserves bytes and parses only after safe new document confirmation',()=>{
 const h=harness(true,true);h.arm(beaconMsg);navigate(h);const body=JSON.stringify(story());const f=h.stream(body,{type:'beacon'});assert.equal(Buffer.concat(f.writes).toString(),body);assert.equal(h.d.loadContext(h.sender).active,true);verify(h);
 const c=h.d.readLoad(msg).counts;assert.equal(c.responseBeaconRead,1);assert.equal(c.responseBeaconFiltered,1);assert.equal(c.responseBeaconCompleted,1);assert.equal(c.responseBeaconBytes,Buffer.byteLength(body));assert.equal(c.responseBeaconNoData,0);assert.equal(c.responseExactIds,1);assert.equal(c.responseTabUnhandled,1);assert(!JSON.stringify(c).includes('PRIVATE'));
});
test('Beacon consent never allows ping, document, script, data, foreign tab/frame/host/origin',()=>{
 const h=harness(true,true);h.arm(beaconMsg);navigate(h);verify(h);
 for(const extra of [{type:'ping'},{type:'script'},{type:'image'},{url:'https://www.facebook.com/data/'},{url:'https://fbcdn.net/ajax/feed/'},{documentUrl:undefined},{documentUrl:url.replace(group,'foreign')},{frameId:1},{tabId:8}])h.request({type:'beacon',...extra});
 assert.equal(h.filters.length,0);h.request({type:'beacon'});assert.equal(h.filters.length,1);
});
test('Beacon reports empty completion separately from non-empty unrecognized content',()=>{
 for(const body of ['', '{}']){const h=harness(true,true);h.arm(beaconMsg);navigate(h);verify(h);h.stream(body,{type:'beacon'});const c=h.d.readLoad(msg).counts;assert.equal(c.responseBeaconCompleted,1);assert.equal(c.responseBeaconNoData,body===''?1:0);assert.equal(c.responseBeaconBytes,Buffer.byteLength(body));assert.equal(c.responseExactIds,0);}
});
test('Beacon shares existing body, total, stream and response budgets',()=>{
 const h=harness(true,true);h.arm(beaconMsg);navigate(h);verify(h);for(let i=0;i<5;i++)h.request({type:'beacon'});assert.equal(h.filters.length,4);h.filters.forEach(f=>f.onstop());for(let i=0;i<6;i++){const n=h.filters.length;h.request({type:'beacon'});if(h.filters.length>n)h.filters.at(-1).onstop();}assert.equal(h.filters.length,8);assert.equal(h.d.readLoad(msg).counts.responseBeaconFiltered,8);
 const t=harness(true,true);t.arm(beaconMsg);navigate(t);verify(t);t.request({type:'beacon'});t.filters[0].ondata({data:new Uint8Array(524289).buffer});assert.equal(t.filters[0].disconnected,true);assert.equal(t.d.readLoad(msg).counts.responseBeaconBytes,0);
});
test('Beacon abort, deadline and late callbacks cannot retain or expose records',()=>{
 for(const action of ['abort','deadline','unverified']){const h=harness(true,true);h.arm(beaconMsg);navigate(h);h.request({type:'beacon'});const f=h.filters[0];if(action==='abort')h.d.abort();if(action==='deadline')h.jump(25001);f.ondata({data:Uint8Array.from(Buffer.from(JSON.stringify(story()))).buffer});f.onstop();assert.equal(h.d.readLoad(msg).counts.responseExactIds,0);}
});
test('Beacon cannot promote bare IDs or foreign permalinks and deduplicates exact IDs',()=>{
 const h=harness(true,true);h.arm(beaconMsg);navigate(h);verify(h);h.stream(JSON.stringify([story(),story('223456789','foreign'),{post_id:'323456789'}]),{type:'beacon'});h.stream(JSON.stringify(story()),{type:'beacon'});const c=h.d.readLoad(msg).counts;assert.equal(c.responseExactIds,1);assert.equal(c.responseDuplicateIds,1);assert.equal(c.responseBeaconCompleted,2);
});

test('real Facebook context cannot activate lab-only Beacon reads even with every consent flag',()=>{
 const h=harness();h.arm(beaconMsg);navigate(h);verify(h);h.request({type:'beacon'});assert.equal(h.filters.length,0);assert.equal(h.d.readLoad(msg).counts.responseBeaconRead,0);
});

test('fast load cadence requires strict scroll and speed consent in the same window',()=>{
 for(const [autoScrollConsent,fastScrollConsent] of [[false,true],[true,'true'],[true,true]]){const h=harness();h.arm({...loadMsg,autoScrollConsent,fastScrollConsent});navigate(h);const c=h.d.loadContext(sender);assert.equal(c.fastScrollConsent,autoScrollConsent===true && fastScrollConsent===true);verify(h);const r=h.d.readLoad(msg).counts;assert.equal(r.responseFastScroll,c.fastScrollConsent?1:0);assert.equal(r.responseScrollCadenceMs,autoScrollConsent?(c.fastScrollConsent?500:2000):0);}
});

const documentMsg={...loadMsg,documentConsent:true};
const documentBody=(records=[story()])=>`<!doctype html><html><body><a href="/groups/${group}/posts/123456789/">post</a><script type="application/json">${JSON.stringify(records)}</script></body></html>`;
const documentStream=(h,body)=>h.stream(body,{type:'main_frame',url:h.sender.url,documentUrl:undefined});
test('document scope is default off and requires distinct strict load-only consent',()=>{
 for(const documentConsent of [undefined,false,'true']){const h=harness();h.arm({...loadMsg,documentConsent});navigate(h);assert.equal(h.filters.length,0);}
 for(const bad of [{reloadConsent:false},{autoScrollConsent:true},{beaconConsent:true}]){const h=harness();assert.equal(h.arm({...documentMsg,...bad}).status,'STOP');assert.equal(h.filters.length,0);}
});
test('one exact document is forwarded byte-for-byte, held until verification and yields only counts',()=>{
 const h=harness();h.arm(documentMsg);const body=documentBody();const f=documentStream(h,body);assert.equal(Buffer.concat(f.writes).toString(),body);
 assert.equal(h.d.confirmLoad({nonce:msg.nonce,safe:true},{...sender,tab:{id:8}}),false);
 // Wrong-tab confirmation cannot abort the bound session.
 assert.equal(verify(h),true);const r=h.d.readLoad(msg);
 assert.equal(r.status,'OK');assert.equal(r.counts.responseDocumentRead,1);assert.equal(r.counts.responseDocumentCompleted,1);assert.equal(r.counts.responseDocumentBytes,Buffer.byteLength(body));assert.equal(r.counts.responseDocumentJsonBlocks,1);assert.equal(r.counts.responseDocumentPermalinks,1);assert.equal(r.counts.responseExactIds,1);
 assert(!JSON.stringify(r).includes('PRIVATE'));assert(!JSON.stringify(r).includes('123456789'));assert(!JSON.stringify(r).includes('facebook.com'));assert.equal(h.d.readLoad(msg).status,'STOP');
});
test('document scope cannot filter subrequests, frames, foreign tabs or a second navigation',()=>{
 const h=harness();h.arm(documentMsg);for(const bad of [{tabId:8,type:'main_frame',url},{frameId:1,type:'sub_frame',url}])h.request(bad);assert.equal(h.filters.length,0);
 documentStream(h,documentBody());for(const type of ['xmlhttprequest','fetch','other','beacon','script','image'])h.request({type});assert.equal(h.filters.length,1);verify(h);navigate(h);assert.equal(h.d.readLoad(msg).status,'STOP');
 for(const bad of [{url:url.replace(group,'foreign')},{url:url+'?x=1'},{frameId:1}]){const p=harness();p.arm(documentMsg);p.request({type:'main_frame',url,...bad});assert.equal(p.filters.length,0);assert.equal(p.d.readLoad(msg).status,'STOP');}
});
test('document parser ignores executable scripts, unbound IDs, foreign links and form text',()=>{
 const h=harness();h.arm(documentMsg);documentStream(h,`<html><body><input value="PRIVATE"><script>${JSON.stringify(story())}</script><script type="application/json">${JSON.stringify([story('223456789','foreign'),{post_id:'333333333'},{message:{text:'450000 zł 50 m2'}}])}</script><a href="https://evil.test/groups/${group}/posts/123456789/">x</a><a href="/groups/foreign/posts/123456789/">x</a></body></html>`);verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseDocumentPermalinks,0);assert.equal(c.responseExactIds,0);assert.equal(c.responsePriceSignals,0);
});
test('document links are separate from offer records, deduplicate and cap at twenty',()=>{
 const h=harness();h.arm(documentMsg);documentStream(h,'<html><body>'+Array.from({length:30},(_,i)=>`<a href="/groups/${group}/posts/${123456780+i}/">x</a>`).join('')+'</body></html>');verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseDocumentPermalinks,20);assert.equal(c.responseExactIds,0);
});
test('document cancellation, verification failure, challenge and late bytes clear all results',()=>{
 for(const action of ['abort','unsafe','expire','challenge']){const h=harness();h.arm(documentMsg);documentStream(h,action==='challenge'?'<form id="login_form">':documentBody());if(action==='abort')h.d.abortLoad(msg);if(action==='unsafe')h.d.confirmLoad({nonce:msg.nonce,safe:false},sender);if(action==='expire')h.jump(25001);assert.equal(h.d.readLoad(msg).status,'STOP');assert.equal(h.d.readLoad(msg).counts.responseExactIds,0);}
 const h=harness();h.arm(documentMsg);h.request({type:'main_frame',url});const f=h.filters[0];h.d.abort();f.ondata({data:Buffer.from(documentBody()).buffer});f.onstop();assert.equal(h.d.readLoad(msg).status,'STOP');assert.equal(h.filters.length,1);
});
test('document has a 2 MiB ceiling and next attempt is clean without reusing consent',()=>{
 const h=harness();h.arm(documentMsg);h.request({type:'main_frame',url});const f=h.filters[0];f.ondata({data:new Uint8Array(2097153).buffer});assert.equal(f.disconnected,true);verify(h);const r=h.d.readLoad(msg);assert.equal(r.counts.responseOversize,1);assert.equal(r.counts.responseDocumentCompleted,0);
 h.request({type:'main_frame',url});assert.equal(h.filters.length,1);assert.equal(h.arm({...loadMsg,nonce:'fresh-after-document'}).status,'ARMED');navigate(h);assert.equal(h.filters.length,1);h.d.abort();
});
test('only valid inert JSON blocks are parsed, with bounded block count and record deduplication',()=>{
 const h=harness();h.arm(documentMsg);documentStream(h,'<html><body>'+`<script type="application/json" src="/x">${JSON.stringify(story())}</script><script type="application/json">invalid</script>`+Array.from({length:70},()=>`<script type="application/json">${JSON.stringify(story())}</script>`).join('')+'</body></html>');verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseDocumentJsonBlocks,62);assert.equal(c.responseExactIds,1);assert(c.responseDuplicateIds>0);
});
test('document block byte budget applies to multibyte UTF8, not character count',()=>{
 const h=harness();h.arm(documentMsg);const large=JSON.stringify({...story(),padding:'ż'.repeat(270000)});assert(large.length<524288);assert(Buffer.byteLength(large)>524288);documentStream(h,`<html><script type="application/json">${large}</script></html>`);verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseDocumentJsonBlocks,0);assert.equal(c.responseExactIds,0);
});
test('comments, raw-text HTML and quoted fake type or href attributes cannot confirm records or links',()=>{
 const h=harness();h.arm(documentMsg);const json=JSON.stringify(story());documentStream(h,`<html><!-- ${documentBody()} --><textarea>${documentBody()}</textarea><style>${documentBody()}</style><script data-label="type='application/json'">${json}</script><a data-label="href='/groups/${group}/posts/123456789/'">x</a><script type="text/javascript" type="application/json">${json}</script></html>`);verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseDocumentJsonBlocks,0);assert.equal(c.responseDocumentPermalinks,0);assert.equal(c.responseExactIds,0);
});

// POC 0.3.9: known wrapper grammar only; not a generic JavaScript interpreter.
test('document statically recognizes both exact ServerJS JSON wrappers without calling page code',()=>{
 for(const wrap of [j=>`require("ServerJS").handle(${j});`,j=>`require('ServerJS') .handle( ${j} )`,j=>`new ServerJS().handle(${j});`]){
  const h=harness();h.arm(documentMsg);documentStream(h,`<script>${wrap(JSON.stringify(story()))}</script>`);verify(h);
  const r=h.d.readLoad(msg);assert.equal(r.counts.responseDocumentJsonBlocks,1);assert.equal(r.counts.responseExactIds,1);assert.equal(r.counts.responsePriceSignals,1);assert.equal(r.counts.responseAreaSignals,1);assert(!JSON.stringify(r).includes('PRIVATE'));
 }
});
test('document wrapper rejects executable expressions and prefix or suffix statements',()=>{
 for(const body of [
  `require("ServerJS").handle(${JSON.stringify(story())});evil()`,
  `evil();require("ServerJS").handle(${JSON.stringify(story())})`,
  `require("ServerJS").handle((()=>${JSON.stringify(story())})())`,
  `require("ServerJS").handle({node: ${JSON.stringify(story())}})`,
  `require("ServerJS").handle(JSON.parse(${JSON.stringify(JSON.stringify(story()))}))`,
  `require("Other").handle(${JSON.stringify(story())})`,
  `window.require("ServerJS").handle(${JSON.stringify(story())})`,
  `require("ServerJS").handle(${JSON.stringify(story())}, {})`,
  `require("ServerJS").handle(${JSON.stringify(story())});/* comment */`,
  `"require(\\"ServerJS\\").handle(${JSON.stringify(story())})"`
 ]){const h=harness();h.arm(documentMsg);documentStream(h,`<script>${body}</script>`);verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseDocumentJsonBlocks,0);assert.equal(c.responseExactIds,0);}
});
test('wrapper type, external script and quoted attribute impersonation fail closed',()=>{
 for(const attrs of ['src="/x"','type="module"','type="text/plain"','type="application/json"','data-label="type=\'text/javascript\'" type="text/plain"','type="text/javascript" type="application/javascript"']){
  const h=harness();h.arm(documentMsg);documentStream(h,`<script ${attrs}>require("ServerJS").handle(${JSON.stringify(story())});</script>`);verify(h);assert.equal(h.d.readLoad(msg).counts.responseExactIds,0);
 }
});
test('recognized wrapper still requires exact group link, deduplicates and caps at twenty',()=>{
 const h=harness();h.arm(documentMsg);const records=[story(),story(),story('223456789','foreign'),{post_id:'333333333'},...Array.from({length:25},(_,i)=>story(String(423456780+i)))];documentStream(h,`<script type="text/javascript">new ServerJS().handle(${JSON.stringify(records)});</script><script>new ServerJS().handle(${JSON.stringify(story())});</script>`);verify(h);const c=h.d.readLoad(msg).counts;assert.equal(c.responseExactIds,20);assert.equal(c.responseDuplicateIds,1);
});
test('wrapper body byte ceiling and cancellation retain existing document protections',()=>{
 const h=harness();h.arm(documentMsg);documentStream(h,`<script>new ServerJS().handle(${JSON.stringify({...story(),padding:'ż'.repeat(270000)})});</script>`);verify(h);assert.equal(h.d.readLoad(msg).counts.responseExactIds,0);
 const p=harness();p.arm(documentMsg);documentStream(p,`<script>new ServerJS().handle(${JSON.stringify(story())});</script>`);p.d.abort();assert.equal(p.d.readLoad(msg).status,'STOP');assert.equal(p.d.readLoad(msg).counts.responseExactIds,0);
});
