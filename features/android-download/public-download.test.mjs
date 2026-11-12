import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {androidRelease as apk} from './release.ts';
const url=`https://flip-manager-ai.vercel.app${apk.path}`;
const etag=`"sha256-${apk.sha256}"`;
// This checks the production HTTP route after deployment, including middleware and CDN.
test('public APK completes and an interrupted download resumes to the exact same SHA-256', {skip:process.env.ANDROID_APK_PUBLIC_CHECK!=='1',timeout:720000},async()=>{
 let ready=false;
 for(let attempt=0;attempt<40;attempt++){
  try{const head=await fetch(url,{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(15000)});ready=head.status===200&&head.headers.get('etag')===etag&&Number(head.headers.get('content-length'))===apk.bytes;}catch{}
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,15000));
 }
 assert.ok(ready,'The current APK route did not become public with the expected release headers');
 const normal=await fetch(url,{signal:AbortSignal.timeout(180000)});assert.equal(normal.status,200);assert.equal(normal.headers.get('etag'),etag);
 const full=createHash('sha256');let total=0;
 for await(const chunk of normal.body){total+=chunk.byteLength;full.update(chunk);}
 assert.equal(total,apk.bytes);assert.equal(full.digest('hex'),apk.sha256);
 const prefix=await fetch(url,{signal:AbortSignal.timeout(180000)});assert.equal(prefix.status,200);
 const hash=createHash('sha256'),reader=prefix.body.getReader();let saved=0;
 try{while(saved<1024*1024){const {value,done}=await reader.read();assert.equal(done,false);saved+=value.byteLength;hash.update(value);}}finally{await reader.cancel();reader.releaseLock();}
 const resumed=await fetch(url,{headers:{Range:`bytes=${saved}-`,'If-Range':etag},signal:AbortSignal.timeout(180000)});
 assert.equal(resumed.status,206);assert.equal(resumed.headers.get('content-range'),`bytes ${saved}-${apk.bytes-1}/${apk.bytes}`);
 for await(const chunk of resumed.body){saved+=chunk.byteLength;hash.update(chunk);}
 assert.equal(saved,apk.bytes);assert.equal(hash.digest('hex'),apk.sha256);
 console.log(`Verified complete and interrupted/resumed public download: ${apk.version}, ${saved} bytes, SHA-256 ${apk.sha256}`);
});
