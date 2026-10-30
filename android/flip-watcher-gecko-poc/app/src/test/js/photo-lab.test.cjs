const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('debug photo lab supplies only configured local pixels and cancels the literal asset elsewhere',()=>{
 let request,receive;const messages=[];const context={URL,setTimeout:()=>{},clearTimeout:()=>{},browser:{webRequest:{onBeforeRequest:{addListener:f=>request=f}},runtime:{connectNative:()=>({postMessage:m=>messages.push(m),onMessage:{addListener:f=>receive=f},onDisconnect:{addListener:()=>{}}})}}};
 vm.runInNewContext(fs.readFileSync('android/flip-watcher-gecko-poc/app/src/debug/photo-lab/background.js','utf8'),context);
 const image='https://scontent-fra3-2.xx.fbcdn.net/v/t39.30808-6/123456789_987654321_555555555_n.jpg?oh=new';const document='http://127.0.0.1:23456/groups/fixture/posts/550000000000091/';
 assert.equal(request({url:image,documentUrl:document}).cancel,true);
 receive({type:'configure',image,document,pixels:'data:image/png;base64,AAAA'});assert.equal(messages[0].type,'configured');
 assert.equal(request({url:image,documentUrl:document}).redirectUrl,'data:image/png;base64,AAAA');
 for(const documentUrl of ['https://www.facebook.com/groups/fixture/posts/550000000000091/',document+'?different=1','http://127.0.0.1:9999/groups/fixture/posts/550000000000091/'])assert.equal(request({url:image,documentUrl}).cancel,true);
 assert.equal(request({url:image+'&unknown=1',documentUrl:document}).cancel,true);
});

test('photo fixture recovers a silent pre-delegate port and ignores late configuration on it',()=>{
 const timers=[],ports=[];let id=0;
 const context={URL,setTimeout(fn,ms){timers.push({id:++id,fn,ms});return id;},clearTimeout(id){const i=timers.findIndex(t=>t.id===id);if(i>=0)timers.splice(i,1);},browser:{webRequest:{onBeforeRequest:{addListener(){}}},runtime:{connectNative(){const p={messages:[],postMessage(m){p.messages.push(m);},disconnect(){p.lost();},onMessage:{addListener(f){p.receive=f;}},onDisconnect:{addListener(f){p.lost=f;}}};ports.push(p);return p;}}}};
 vm.runInNewContext(fs.readFileSync('android/flip-watcher-gecko-poc/app/src/debug/photo-lab/background.js','utf8'),context);
 assert.equal(timers[0].ms,2000);timers.shift().fn();assert.equal(timers[0].ms,250);timers.shift().fn();
 const cfg={type:'configure',document:'http://127.0.0.1:23456/groups/fixture/posts/550000000000091/',image:'https://scontent-fra3-2.xx.fbcdn.net/v/t39.30808-6/123456789_987654321_555555555_n.jpg?oh=new',pixels:'data:image/png;base64,AAAA'};
 ports[0].receive(cfg);assert.equal(ports[0].messages.length,0);assert.equal(timers.length,1);ports[1].receive(cfg);assert.equal(timers.length,0);assert.equal(ports[1].messages[0].type,'configured');
});
