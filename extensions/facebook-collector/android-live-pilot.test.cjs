const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const asset = name => fs.readFileSync(path.join(root,'android/flip-collector/app/src/main/assets',name),'utf8');
const core = fs.readFileSync(path.join(__dirname,'collector-core.js'),'utf8');
const source = {sourceType:'GROUP',sourceId:'offline-lodz',sourceUrl:'https://www.facebook.com/groups/offline-lodz/'};
function collect({stories=[],body='',selector=null,pathname='/groups/offline-lodz/',origin='https://www.facebook.com',cards=[]}={}) {
  const messages=[];
  const document={body:{textContent:body},querySelector:s=>s===selector?{}:null,querySelectorAll:s=>s.startsWith('script')?[{textContent:JSON.stringify({stories})}]:cards};
  const sandbox={URL,Date,location:{pathname,origin},FlipPilot:{postMessage:raw=>messages.push(JSON.parse(raw))}};
  vm.createContext(sandbox);
  vm.runInContext(core+'\n'+asset('facebook-offline-adapter.js')+'\n'+asset('facebook-live-pilot.js'),sandbox);
  sandbox.FlipAndroidLivePilot(document,source,'nonce',Date.now());
  assert.equal(messages.length,1);
  return messages[0];
}
function story(id='100000000001') {
  return {__typename:'Story',post_id:id,permalink_url:source.sourceUrl+'posts/'+id+'/',actor:{name:'Fixture'},message:{text:'Sprzedam mieszkanie 42 m2 Łódź Retkinia cena 260 tys.'},attachments:[{__typename:'Photo',media_id:'200000000001',image:{uri:'https://scontent.xx.fbcdn.net/room.jpg'}}]};
}
test('collector artifact pin matches exact unchanged extension core',()=>{
  const hash=crypto.createHash('sha256').update(core).digest('hex');
  const policy=fs.readFileSync(path.join(root,'android/flip-collector/app/src/main/java/pl/jakubokruszek/flipcollector/collector/LivePilotPolicy.kt'),'utf8');
  assert.ok(policy.includes(hash));
});
test('real DOM adapter reuses core identity/media, deduplicates and caps twenty',()=>{
  const result=collect({stories:[story(),story(),...Array.from({length:25},(_,i)=>story(String(100000000002+i)))]});
  assert.equal(result.batch.posts.length,20);
  assert.equal(new Set(result.batch.posts.map(p=>p.postId)).size,20);
  assert.equal(result.batch.posts[0].identityConfidence,'EXACT');
  assert.equal(result.batch.posts[0].media[0].exactPostId,'100000000001');
  assert.equal(result.batch.imageMode,'SOURCE_SCAN_DATA_ONLY');
  assert.equal(result.batch.health.stopReason,'POST_LIMIT');
});
test('login checkpoint CAPTCHA and unavailable group produce STOP only',()=>{
  for(const [input,stop] of [[{pathname:'/login/'},'LOGIN_REQUIRED'],[{pathname:'/checkpoint/'},'CHECKPOINT'],[{pathname:'/captcha/'},'CAPTCHA'],[{body:"This content isn't available"},'GROUP_UNAVAILABLE'],[{pathname:'/groups/other/'},'GROUP_UNAVAILABLE'],[{origin:'https://evil.test'},'GROUP_UNAVAILABLE']]) {
    const result=collect({...input,stories:[story()]});assert.equal(result.stop,stop);assert.equal(result.batch,undefined);
  }
});
test('unverified or empty DOM never invents an offer',()=>{
  assert.equal(collect().stop,'NO_VERIFIED_POSTS');
  const unknown=story();delete unknown.actor;
  assert.equal(collect({stories:[unknown]}).stop,'NO_VERIFIED_POSTS');
});
test('adjacent story media stays bound to its own post',()=>{
  const sale=story();sale.attachments.push({...story('999999999999'),attachments:[{__typename:'Photo',media_id:'299999999999',image:{uri:'https://scontent.xx.fbcdn.net/neighbor.jpg'}}]});
  const result=collect({stories:[sale]});
  assert.equal(result.batch.posts[0].media.length,1);
  assert.equal(result.batch.posts[0].media[0].mediaId,'200000000001');
});
