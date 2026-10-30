/* Dedicated instance of the existing bounded response transport; private tab-scoped local results. */
(function(root){
'use strict';
function create(api,core,fields,factory,timers=root){
 let state=null;const revoked=new Set(),preview=root.FlipDesktopPreview||(typeof require==='function'?require('./desktop-preview.js'):null);
 const now=()=>timers.performance?.now?.()??Date.now();
 const net=factory.create(api,core,timers,{desktop:true,onRecord(r){if(state)state.model.add(r,'NETWORK');},onRelease(){if(state)state.model.clear();}});
 const empty=()=>({status:'STOP',rows:[],stats:preview.zero()});
 function abort(m){
  if(typeof m?.nonce!=='string')return;revoked.add(m.nonce);while(revoked.size>32)revoked.delete(revoked.values().next().value);
  net.abortLoad(m);if(state?.nonce===m.nonce){timers.clearTimeout(state.timer);state.model.clear();state=null;}
 }
 function abortAll(){if(state)abort({nonce:state.nonce});net.abort();}
 function arm(m,sender){
  if(m?.consent!==true||m.desktopConsent!==true||!Number.isInteger(sender?.tab?.id)||sender.tab.id<0||sender.frameId!==0||!preview.groupURL(sender.url,m.groupId,m.fixture===true)||!(/^[a-f0-9-]{36}$/).test(m.nonce)||revoked.has(m.nonce))return {status:'STOP'};
  if(state)return {status:'BUSY'};
  const wait=Math.max(2000,Math.min(60000,Number(m.windowMs)||60000));
  state={nonce:m.nonce,tab:sender.tab.id,group:m.groupId,url:sender.url,fixture:m.fixture===true,model:preview.createModel(core,fields,m.groupId),deadline:now()+wait};
  const ack=net.arm({...m,reloadConsent:true,beaconConsent:false,documentConsent:false,autoScrollConsent:false,windowMs:wait},sender);
  if(ack.status!=='ARMED'){state.model.clear();state=null;return {status:ack.status};}
  state.timer=timers.setTimeout(()=>abort({nonce:m.nonce}),wait);
  return {status:'ARMED'};
 }
 function context(m,sender){const s=state,info=net.loadContext(sender);return {active:!!(s&&s.nonce===m.nonce&&info.active&&now()<s.deadline),nonce:s?.nonce===m.nonce?m.nonce:'',remainingMs:s?.nonce===m.nonce?Math.max(0,s.deadline-now()):0};}
 function confirm(m,sender){if(!context(m,sender).active||m.safe!==true)return {confirmed:false};const confirmed=net.confirmLoad(m,sender);if(confirmed)state.confirmed=true;return {confirmed};}
 function snapshot(m,sender){
  if(!context(m,sender).active||state.confirmed!==true)return {status:'STOP',rows:[],media:[]};
  return {status:'OK',rows:state.model.rows(),media:state.model.mediaBindings()};
 }
 function read(m,sender){
  if(!context(m,sender).active)return empty();const s=state,rows=s.model.rows(),stats={...s.model.stats};
  const result=net.readLoad(m);timers.clearTimeout(s.timer);s.model.clear();state=null;
  if(result.status!=='OK')return empty();
  Object.assign(stats,{network:result.counts.responseExactIds,requests:result.counts.responseRequestsSeen,bytes:result.counts.responseBytes,verified:result.counts.responseLoadVerified,filtered:result.counts.responseFiltered,completed:result.counts.responseCompleted,streamErrors:result.counts.responseStreamErrors,decodeErrors:result.counts.responseDecodeErrors,oversize:result.counts.responseOversize,limitSkipped:result.counts.responseLimitSkipped});
  return {status:'OK',rows,stats};
 }
 return {arm,context,confirm,snapshot,read,abort,abortAll,stop(m,sender){if(state&&state.nonce===m?.nonce&&state.tab===sender?.tab?.id&&sender.frameId===0)abort(m);}};
}
const out={create};if(typeof module!=='undefined')module.exports=out;
if(root.browser){const d=create(browser,root.FlipFacebookCollectorCore,root.FlipDesktopFields,root.FlipResponseFactory);root.FlipDesktopBackground=d;
 browser.runtime.onMessage.addListener((m,sender)=>{
  if(m?.type==='armDesktop')return Promise.resolve(d.arm(m,sender));
  if(m?.type==='desktopContext')return Promise.resolve(d.context(m,sender));
  if(m?.type==='confirmDesktop')return Promise.resolve(d.confirm(m,sender));
  if(m?.type==='desktopSnapshot')return Promise.resolve(d.snapshot(m,sender));
  if(m?.type==='readDesktop')return Promise.resolve(d.read(m,sender));
  if(m?.type==='stopDesktop'){d.stop(m,sender);return Promise.resolve({stopped:true});}
  return undefined;
 });
}
})(globalThis);
