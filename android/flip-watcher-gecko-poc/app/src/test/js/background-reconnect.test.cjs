const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness(throws=0){
 const timers=[],ports=[];let attempts=0,aborts=0,projects=0;
 const counter=()=>({isArmed:()=>false,abort(){aborts++;}});
 const context={URL,FlipGeckoPocAdapter:{createTrafficCounter:counter,createLoadCounter:counter},FlipOcrFields:{create:()=>({project:()=>{projects++;return{type:'ocrFieldsResult'};}})},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},browser:{runtime:{onMessage:{addListener(){}},connectNative(name){assert.equal(name,'flipPoc');if(attempts++<throws)throw Error('native delegate not registered');const p={messages:[],postMessage(m){this.messages.push(m);},onMessage:{addListener(f){p.receive=f;}},onDisconnect:{addListener(f){p.disconnect=f;}}};ports.push(p);return p;}}}};
 vm.runInNewContext(fs.readFileSync('android/flip-watcher-gecko-poc/app/src/main/extension/poc-background.js','utf8'),context);
 return{timers,ports,tick(){const t=timers.shift();assert(t);t.fn();return t.ms;},get attempts(){return attempts;},get aborts(){return aborts;},get projects(){return projects;}};
}
test('background retries native registration failure without starting or replaying a job',()=>{
 const h=harness(1);assert.equal(h.attempts,1);assert.equal(h.timers.length,1);assert.equal(h.tick(),250);assert.equal(h.ports.length,1);assert.equal(h.timers.length,0);assert.equal(h.projects,0);assert.equal(h.ports[0].messages.length,0);
 h.ports[0].receive({type:'ocrFields',nonce:'explicit-new-request'});assert.equal(h.projects,1);assert.equal(h.ports[0].messages[0].nonce,'explicit-new-request');
});
test('disconnect aborts old work and reconnects; stale ports cannot reply or schedule extra retries',()=>{
 const h=harness(),old=h.ports[0];old.disconnect();assert.equal(h.aborts,1);assert.equal(h.timers.length,1);old.disconnect();assert.equal(h.aborts,1);assert.equal(h.timers.length,1);h.tick();const fresh=h.ports[1];
 old.receive({type:'ocrFields',nonce:'old'});assert.equal(h.projects,0);assert.equal(fresh.messages.length,0);assert.equal(h.timers.length,0);
 fresh.receive({type:'ocrFields',nonce:'new'});assert.equal(h.projects,1);assert.equal(fresh.messages[0].nonce,'new');assert.equal(old.messages.length,0);
});
test('registration retry backs off to four seconds and keeps only one pending timer',()=>{
 const h=harness(8),delays=[];while(h.ports.length===0){assert.equal(h.timers.length,1);delays.push(h.tick());}
 assert.deepEqual(delays,[250,500,1000,2000,4000,4000,4000,4000]);assert.equal(h.projects,0);assert.equal(h.timers.length,0);
});
test('APK and built-in collector extension versions advance together for ensureBuiltIn upgrades',()=>{
 const manifest=JSON.parse(fs.readFileSync('android/flip-watcher-gecko-poc/app/src/main/extension/manifest.json','utf8'));
 const gradle=fs.readFileSync('android/flip-watcher-gecko-poc/app/build.gradle.kts','utf8');const version=/versionName\s*=\s*"([0-9.]+)-gecko-poc"/.exec(gradle)?.[1];
 assert(version);assert.equal(manifest.version,version,'ensureBuiltIn retains old extension code when its manifest version does not advance');
});
