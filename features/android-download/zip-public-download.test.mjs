import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {androidRelease,androidRelease104,androidZip105 as apk} from './release.ts';
// The diagnostic release is opt-in; the normal installer must stay on 104.
test('diagnostic release does not change the public default',()=>assert.deepEqual(androidRelease,androidRelease104));
test('ZIP alternative completes, resumes, and finishes saving in Chrome',{skip:process.env.ANDROID_APK_PUBLIC_CHECK!=='1',timeout:720000},async()=>{
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
  await page.evaluate(path=>{const link=document.createElement('a');link.id='optional-diagnostic-zip';link.href=path;link.textContent='Optional diagnostic APK';document.body.appendChild(link);},apk.path);
  const pending=page.waitForEvent('download',{timeout:30000});await page.locator('#optional-diagnostic-zip').click();
  const download=await pending;assert.equal(download.suggestedFilename(),apk.filename);
  const path=await download.path();assert.equal(await download.failure(),null);assert.ok(path);
  let chromeBytes=0;const hash=createHash('sha256');for await(const chunk of createReadStream(path)){chromeBytes+=chunk.byteLength;hash.update(chunk);}
  assert.equal(chromeBytes,apk.bytes);assert.equal(hash.digest('hex'),apk.sha256);
  const extracted=execFileSync('python3',['-c',`import zipfile,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.namelist()==['flip-watcher-0.5.105-arm64.apk']
 h=hashlib.sha256()
 with z.open(z.namelist()[0]) as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
 assert h.hexdigest()=='b96065326061c6d301397a140da82412b2e459179d16add18b7d55a8c51be4cf'
 print('Extracted signed APK hash verified')`,path],{encoding:'utf8'});
  assert.match(extracted,/Extracted signed APK hash verified/);
  console.log(`ZIP full/resume/Chrome verified: ${apk.version}, ${chromeBytes} bytes, SHA-256 ${apk.sha256}`);
 }finally{await browser.close();}
});
