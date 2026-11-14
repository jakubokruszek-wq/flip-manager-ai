import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,createReadStream} from 'node:fs';
import {promisify} from 'node:util';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const m=JSON.parse(await promisify(readFile)(process.argv[2],'utf8'));
assert.match(m.url,/^https:\/\/github\.com\/jakubokruszek-wq\/flip-manager-ai\/releases\/download\/gecko-poc-0\.5\.108\/flip-watcher-0\.5\.108-arm64\.zip$/);
async function verify(){
 const full=await fetch(m.url,{signal:AbortSignal.timeout(180000)});assert.equal(full.status,200);
 const hash=createHash('sha256');let total=0;for await(const chunk of full.body){total+=chunk.byteLength;hash.update(chunk);}
 assert.equal(total,m.bytes);assert.equal(hash.digest('hex'),m.sha256);
 const prefix=await fetch(m.url,{signal:AbortSignal.timeout(180000)});assert.equal(prefix.status,200);
 const reader=prefix.body.getReader(),resumedHash=createHash('sha256');let saved=0;
 try{while(saved<1048576){const {value,done}=await reader.read();assert.equal(done,false);saved+=value.byteLength;resumedHash.update(value);}}finally{await reader.cancel();reader.releaseLock();}
 const remaining=await fetch(m.url,{headers:{Range:`bytes=${saved}-`},signal:AbortSignal.timeout(180000)});
 assert.equal(remaining.status,206);assert.equal(remaining.headers.get('content-range'),`bytes ${saved}-${m.bytes-1}/${m.bytes}`);
 for await(const chunk of remaining.body){saved+=chunk.byteLength;resumedHash.update(chunk);}
 assert.equal(saved,m.bytes);assert.equal(resumedHash.digest('hex'),m.sha256);
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
  await page.setContent('<a id="download">Pobierz aktualizację ZIP</a>');await page.locator('#download').evaluate((a,url)=>a.href=url,m.url);
  const pending=page.waitForEvent('download',{timeout:60000});await page.locator('#download').click();const download=await pending;
  assert.equal(download.suggestedFilename(),m.filename);const path=await download.path();assert.equal(await download.failure(),null);assert.ok(path);
  const chromeHash=createHash('sha256');let chromeBytes=0;for await(const chunk of createReadStream(path)){chromeBytes+=chunk.byteLength;chromeHash.update(chunk);}
  assert.equal(chromeBytes,m.bytes);assert.equal(chromeHash.digest('hex'),m.sha256);
  const extracted=execFileSync('python3',['-c',`import zipfile,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.namelist()==[sys.argv[2]]
 assert z.getinfo(sys.argv[2]).file_size==int(sys.argv[4])
 h=hashlib.sha256()
 with z.open(sys.argv[2]) as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 assert h.hexdigest()==sys.argv[3]
 print('Extracted APK matches verified native build')`,path,m.apkFilename,m.apkSha256,String(m.apkBytes)],{encoding:'utf8'});
  console.log(extracted.trim());console.log(`ZIP full/resume/Chrome completed: ${m.filename}, ${m.bytes} bytes, SHA-256 ${m.sha256}; APK SHA-256 ${m.apkSha256}`);
 }finally{await browser.close();}
}
try{await verify();}catch(error){console.error(error);if(error?.cause)console.error('Network cause:',error.cause);process.exitCode=1;}
