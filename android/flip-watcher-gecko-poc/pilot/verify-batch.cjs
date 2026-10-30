'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
async function loadNormalizer(){
 const pin=JSON.parse(fs.readFileSync(path.join(__dirname,'reference/pin.json'),'utf8'));
 const bytes=fs.readFileSync(path.join(__dirname,'reference/facebook-batch.ts'));
 assert.equal(pin.commit,'8f2e4eada2360a2a30b6d463680de67817361847');
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),pin.sha256);
 assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex'),pin.gitBlobSha);
 const {stripTypeScriptTypes}=require('node:module');
 const code=stripTypeScriptTypes(bytes.toString('utf8'),{mode:'strip'});
 return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).normalizeFacebookCollectorBatch;
}
async function verify(file){
 const normalize=await loadNormalizer();const actual=JSON.parse(fs.readFileSync(file,'utf8'));
 // SignedCollectorClient owns this field in the real flow. No request is signed or sent here.
 actual.batchId='11111111-1111-4111-8111-111111111111';
 const result=normalize(actual);
 assert.equal(result.sourceId,'lodzsprzedazzakupwynajem');assert.equal(result.posts.length,1);
 assert.equal(result.posts[0].postId,'550000000000091');assert.equal(result.posts[0].text,'REAL_SOURCE_FIXTURE');
 assert.equal(result.posts[0].identityConfidence,'EXACT');assert.equal(result.posts[0].firstSeenIteration,2);
 assert.equal(result.health.status,'DEGRADED');assert.equal(result.health.visibleCardCount,7);
 assert.equal(result.health.capturedPostCount,1);assert.equal(result.health.scrolls,29);assert.equal(result.health.durationMs,30000);
 assert.equal(result.imageMode,'SOURCE_SCAN_DATA_ONLY');assert(!JSON.stringify(result).includes('SECRET'));
 console.log('Actual JVM pilot snapshot -> unchanged pinned backend normalizer: PASS (synthetic, no HTTP)');
}
module.exports={loadNormalizer,verify};
if(require.main===module)verify(process.argv[2]).catch(()=>{console.error('Pilot backend contract: FAIL');process.exitCode=1;});
