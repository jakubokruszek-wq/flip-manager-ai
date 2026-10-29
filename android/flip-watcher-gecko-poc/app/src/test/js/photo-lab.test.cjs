const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('debug photo lab supplies only configured local pixels and cancels the literal asset elsewhere',()=>{
 let request,receive;const messages=[];const context={URL,setTimeout:()=>{},browser:{webRequest:{onBeforeRequest:{addListener:f=>request=f}},runtime:{connectNative:()=>({postMessage:m=>messages.push(m),onMessage:{addListener:f=>receive=f},onDisconnect:{addListener:()=>{}}})}}};
 vm.runInNewContext(fs.readFileSync('android/flip-watcher-gecko-poc/app/src/debug/photo-lab/background.js','utf8'),context);
 const image='https://scontent-fra3-2.xx.fbcdn.net/v/t39.30808-6/123456789_987654321_555555555_n.jpg?oh=new';const document='http://127.0.0.1:23456/groups/fixture/posts/550000000000091/';
 assert.equal(request({url:image,documentUrl:document}).cancel,true);
 receive({type:'configure',image,document,pixels:'data:image/png;base64,AAAA'});assert.equal(messages[0].type,'configured');
 assert.equal(request({url:image,documentUrl:document}).redirectUrl,'data:image/png;base64,AAAA');
 for(const documentUrl of ['https://www.facebook.com/groups/fixture/posts/550000000000091/',document+'?different=1','http://127.0.0.1:9999/groups/fixture/posts/550000000000091/'])assert.equal(request({url:image,documentUrl}).cancel,true);
 assert.equal(request({url:image+'&unknown=1',documentUrl:document}).cancel,true);
});
