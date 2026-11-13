import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {androidRelease,androidRelease104,androidRelease105 as apk} from './release.ts';
// The diagnostic release is opt-in; the normal installer must stay on 104.
test('diagnostic release does not change the public default',()=>assert.deepEqual(androidRelease,androidRelease104));
test('optional diagnostic APK completes, resumes, and finishes saving in Chrome',{skip:process.env.ANDROID_APK_PUBLIC_CHECK!=='1',timeout:720000},async()=>{
 const url=`https://flip-manager-ai.vercel.app${apk.path}`,etag=`"sha256-${apk.sha256}"`;
 let ready=false;
 for(let attempt=0;attempt<40;attempt++){
  try{const head=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(15000)});ready=head.status===200&&head.headers.get('etag')===etag&&Number(head.headers.get('content-length'))===apk.bytes;}catch{}
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,15000));
 }
 assert.ok(ready,'Diagnostic route must be public with the pinned release headers');
 const response=await fetch(url,{signal:AbortSignal.timeout(180000)});assert.equal(response.status,200);
 let bytes=0;const full=createHash('sha256');
 for await(const chunk of response.body){bytes+=chunk.byteLength;full.update(chunk);}
 assert.equal(bytes,apk.bytes);assert.equal(full.digest('hex'),apk.sha256);
 const prefix=await fetch(url,{signal:AbortSignal.timeout(180000)});assert.equal(prefix.status,200);
 const reader=prefix.body.getReader(),resumedHash=createHash('sha256');let saved=0;
 try{while(saved<1024*1024){const {value,done}=await reader.read();assert.equal(done,false);saved+=value.byteLength;resumedHash.update(value);}}finally{await reader.cancel();reader.releaseLock();}
 const rest=await fetch(url,{headers:{Range:`bytes=${saved}-`,'If-Range':etag},signal:AbortSignal.timeout(180000)});
 assert.equal(rest.status,206);assert.equal(rest.headers.get('content-range'),`bytes ${saved}-${apk.bytes-1}/${apk.bytes}`);
 for await(const chunk of rest.body){saved+=chunk.byteLength;resumedHash.update(chunk);}
 assert.equal(saved,apk.bytes);assert.equal(resumedHash.digest('hex'),apk.sha256);
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
  await page.goto('https://flip-manager-ai.vercel.app/android',{waitUntil:'domcontentloaded'});
  // Exercise the separate direct link without changing the default page download.
  await page.evaluate(path=>{const link=document.createElement('a');link.id='optional-diagnostic-apk';link.href=path;link.textContent='Optional diagnostic APK';document.body.appendChild(link);},apk.path);
  const pending=page.waitForEvent('download',{timeout:30000});await page.locator('#optional-diagnostic-apk').click();
  const download=await pending;assert.equal(download.suggestedFilename(),apk.filename);
  const path=await download.path();assert.equal(await download.failure(),null);assert.ok(path);
  let chromeBytes=0;const hash=createHash('sha256');for await(const chunk of createReadStream(path)){chromeBytes+=chunk.byteLength;hash.update(chunk);}
  assert.equal(chromeBytes,apk.bytes);assert.equal(hash.digest('hex'),apk.sha256);
  console.log(`Diagnostic APK full/resume/Chrome verified: ${apk.version}, ${chromeBytes} bytes, SHA-256 ${apk.sha256}`);
 }finally{await browser.close();}
});
