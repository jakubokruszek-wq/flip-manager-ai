const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const main=path.resolve(__dirname,'../../main'),read=name=>fs.readFileSync(path.join(main,name),'utf8');
const kotlin=read('java/pl/jakubokruszek/flipwatcher/geckopoc/WatcherGroups.kt');
const ids=['lodzsprzedazzakupwynajem',...Array.from(kotlin.matchAll(/WatcherGroup\("([^"]+)"/g),m=>m[1])];
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,preview=require('../../main/extension/desktop-preview.js'),fields=require('../../main/extension/desktop-fields.js'),ocr=require('../../main/extension/ocr-fields.js');
test('native Watcher catalog and all manifest host matches describe the same eleven sources',()=>{
 assert.equal(ids.length,11);assert.equal(new Set(ids).size,11);
 const early=JSON.parse(read('extension/manifest.json')).content_scripts.find(x=>x.world==='MAIN');
 const expected=['www.facebook.com','m.facebook.com','facebook.com'].flatMap(host=>ids.map(id=>`https://${host}/groups/${id}/*`));
 assert.deepEqual(early.matches.filter(x=>x.startsWith('https:')).sort(),expected.sort());
 assert(!ids.includes('870957041215365'));assert(!ids.includes('2928219830782023'));assert(!ids.includes('61563667387467'));
});
test('OCR projection keeps the selected source identity for all configured groups',()=>{
 for(const groupId of ids){
  const result=ocr.create().project({nonce:'12345678-1234-1234-1234-123456789012',consent:true,groupId,postId:'550000000000099',texts:['Sprzedam mieszkanie 45m2 za 310000 zł']},core,fields,preview);
  assert.equal(result.status,'OK',groupId);assert.equal(result.rows.length,1,groupId);
  assert.equal(result.rows[0].permalink,`https://www.facebook.com/groups/${groupId}/posts/550000000000099/`);
  assert.equal(result.rows[0].price,310000);
 }
});
