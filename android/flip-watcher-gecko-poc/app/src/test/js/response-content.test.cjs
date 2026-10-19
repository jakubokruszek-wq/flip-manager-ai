const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(loadInfo=null){
 let handler,disconnect,watchAbort,disposed=0,now=0;const messages=[],runtime=[],timers=[];
 const doc={title:'Group',visibilityState:'visible',body:{innerText:''},documentElement:{},forms:[],getElementsByTagName:()=>[],querySelector:()=>null,querySelectorAll:()=>[]};
 const port={postMessage:m=>messages.push(m),onMessage:{addListener(fn){handler=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}}};
 const scope={URL,Date,Promise,performance:{now:()=>now},scrollY:0,scrollBy(o){this.scrollY+=o.top;},document:doc,location:{href:'https://www.facebook.com/groups/group/',hostname:'www.facebook.com',pathname:'/groups/group/'},innerWidth:400,innerHeight:600,MutationObserver:class {observe(){}},FlipGeckoPocAdapter:{},FlipFacebookCollectorCore:{},FlipVisiblePosts:{context:()=>true,watch(w,r,abort){watchAbort=abort;return()=>disposed++;}},setTimeout(fn,ms){timers.push({fn,ms});},browser:{runtime:{connectNative:()=>port,async sendMessage(m){if(m.type==='responseLoadContext')return loadInfo?{...loadInfo}:{active:false};runtime.push(m);if(m.type==='confirmResponseLoad')return {confirmed:true};if(m.type==='recordResponseLoadScroll')return {recorded:true};return {status:m.type==='armResponse'?'ARMED':'OK',counts:{}};}}}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../main/extension/poc-content.js'),'utf8'),scope);
 return {advance(){const t=timers.shift();assert(t);now+=t.ms;t.fn();},jump(ms){now+=ms;},doc,scope,messages,runtime,timers,send:m=>handler(m),disconnect:()=>disconnect(),abort:()=>watchAbort(),disposed:()=>disposed};
}
const request={type:'responseDiagnosis',nonce:'fresh-consent',consent:true,groupId:'group',windowMs:15000};
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
test('content layer refuses absent consent before arming or reading',async()=>{const h=harness();await h.send({...request,consent:false,autoScrollConsent:true});assert.equal(h.runtime.length,0);assert.equal(h.messages.at(-1).status,'STOP');});
test('native stop cancels the window immediately and permits a fresh attempt',async()=>{const h=harness();const pending=h.send(request);await flush();assert(h.runtime.some(m=>m.type==='armResponse'));await h.send({type:'abortResponseDiagnosis',nonce:'native-stop'});await pending;assert.equal(h.messages.at(-1).status,'STOP');assert.equal(h.disposed(),1);assert(!h.runtime.some(m=>m.type==='readResponse'));const again=h.send({...request,nonce:'new-consent'});await flush();h.abort();await again;assert.equal(h.runtime.filter(m=>m.type==='armResponse').length,2);});
test('page watcher and port disconnect cancel instead of waiting fifteen seconds',async()=>{for(const action of ['abort','disconnect']){const h=harness();const p=h.send(request);await flush();h[action]();await p;assert.equal(h.messages.at(-1).status,'STOP');assert(h.runtime.some(m=>m.type==='stopResponse'));assert.equal(h.disposed(),1);}});
test('context disappearing while arm is in flight stops and cleans the armed session',async()=>{const h=harness();const p=h.send(request);h.doc.visibilityState='hidden';await p;assert.equal(h.messages.at(-1).status,'STOP');assert(h.runtime.some(m=>m.type==='stopResponse'));assert(!h.runtime.some(m=>m.type==='readResponse'));});

test('automatic scroll is off without separate explicit consent',async()=>{
 for(const value of [undefined,false,'true']){const h=harness();const p=h.send({...request,autoScrollConsent:value});await flush();h.advance();await p;assert.equal(h.scope.scrollY,0);assert.equal(h.messages.at(-1).counts.responseAutoScroll,0);assert.equal(h.messages.at(-1).counts.responseScrollSteps,0);}
});
test('explicit scrolling is bounded to five steps inside the armed fifteen seconds',async()=>{
 const h=harness();const p=h.send({...request,autoScrollConsent:true});await flush();assert.equal(h.scope.scrollY,0);
 for(let i=0;i<5;i++){h.advance();await flush();}
 assert.equal(h.scope.scrollY,5*540);h.advance();await p;
 const c=h.messages.at(-1).counts;assert.equal(c.responseAutoScroll,1);assert.equal(c.responseScrollSteps,5);assert.equal(c.responseScrollMoves,5);assert(h.runtime.some(m=>m.type==='readResponse'));
});
test('cancellation or lost visibility prevents subsequent automatic scrolling',async()=>{
 for(const action of ['cancel','hidden']){const h=harness();const p=h.send({...request,autoScrollConsent:true});await flush();h.advance();await flush();assert.equal(h.scope.scrollY,540);
 if(action==='cancel')await h.send({type:'abortResponseDiagnosis',nonce:'stop'});else {h.doc.visibilityState='hidden';h.advance();}
 await p;assert.equal(h.scope.scrollY,540);assert.equal(h.messages.at(-1).status,'STOP');assert(!h.runtime.some(m=>m.type==='readResponse'));}
});
test('a delayed timer after the deadline performs no scroll',async()=>{
 const h=harness();const p=h.send({...request,autoScrollConsent:true});await flush();h.jump(20000);h.advance();await flush();assert.equal(h.scope.scrollY,0);h.advance();await p;assert.equal(h.messages.at(-1).counts.responseScrollSteps,0);
});

test('reload prepare requires both fresh permissions and does not start scroll or scan',async()=>{const h=harness();await h.send({...request,type:'prepareResponseLoad',reloadConsent:false});assert.equal(h.messages.at(-1).status,'STOP');assert.equal(h.runtime.length,0);await h.send({...request,type:'prepareResponseLoad',reloadConsent:true});assert.equal(h.messages.at(-1).status,'ARMED');assert.equal(h.runtime[0].reloadConsent,true);assert.equal(h.scope.scrollY,0);});
test('new document adopts only an already armed load and aborts on lost context',async()=>{const h=harness({active:true,nonce:'controlled-load',groupId:'group',fixture:false});await flush();assert(h.runtime.some(m=>m.type==='confirmResponseLoad'));h.abort();assert(h.runtime.some(m=>m.type==='stopResponse'&&m.nonce==='controlled-load'));assert(h.messages.some(m=>m.type==='visiblePostsStop'));});
test('unsafe new document never confirms the load',async()=>{const h=harness({active:true,nonce:'controlled-load',groupId:'group',fixture:false});h.doc.visibilityState='hidden';await flush();assert(!h.runtime.some(m=>m.type==='confirmResponseLoad'));assert(h.runtime.some(m=>m.type==='stopResponse'));});

test('combined load scrolling requires explicit consent recovered from bound background',async()=>{
 for(const value of [undefined,false,'true']){const h=harness({active:true,nonce:'load-consent',groupId:'group',remainingMs:25000,autoScrollConsent:value});await flush();assert.equal(h.timers.length,0);assert.equal(h.scope.scrollY,0);assert(!h.runtime.some(m=>m.type==='recordResponseLoadScroll'));}
});
test('combined load uses five bounded steps and no extra navigation or scan',async()=>{
 const h=harness({active:true,nonce:'load-consent',groupId:'group',remainingMs:25000,autoScrollConsent:true});await flush();
 for(let i=0;i<5;i++){h.advance();await flush();}
 assert.equal(h.scope.scrollY,2700);assert.equal(h.timers.length,0);
 const records=h.runtime.filter(m=>m.type==='recordResponseLoadScroll');assert.deepEqual(records.map(m=>m.step),[1,2,3,4,5]);assert(records.every(m=>m.moved===true));assert(!h.runtime.some(m=>/scan|armResponse|readResponse$/.test(m.type)));
});
test('load time consumes scroll budget and delayed timer cannot renew it',async()=>{
 for(const remainingMs of [800,25000]){const h=harness({active:true,nonce:'load-consent',groupId:'group',remainingMs,autoScrollConsent:true});await flush();if(h.timers.length){h.jump(26000);h.advance();await flush();}assert.equal(h.scope.scrollY,0);assert(!h.runtime.some(m=>m.type==='recordResponseLoadScroll'));}
});
test('load scroll stops on cancellation, disconnect, hidden page and changed background nonce',async()=>{
 for(const action of ['cancel','disconnect','hidden','nonce']){const info={active:true,nonce:'load-consent',groupId:'group',remainingMs:25000,autoScrollConsent:true};const h=harness(info);await flush();h.advance();await flush();assert.equal(h.scope.scrollY,540);
 if(action==='cancel')await h.send({type:'abortResponseDiagnosis',nonce:'stop'});if(action==='disconnect')h.disconnect();if(action==='hidden')h.doc.visibilityState='hidden';if(action==='nonce')info.nonce='later-window';
 h.advance();await flush();assert.equal(h.scope.scrollY,540);assert.equal(h.runtime.filter(m=>m.type==='recordResponseLoadScroll').length,1);}
});
test('prepare forwards only boolean scroll consent and never scrolls the old document',async()=>{
 for(const value of [undefined,false,'true',true]){const h=harness();await h.send({...request,type:'prepareResponseLoad',reloadConsent:true,autoScrollConsent:value});assert.equal(h.runtime.find(m=>m.type==='armResponse').autoScrollConsent,value===true);assert.equal(h.scope.scrollY,0);}
});
