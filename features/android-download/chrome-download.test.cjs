/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createReadStream}=require('node:fs');
const {chromium}=require('playwright');
test('Chrome finishes saving the public APK and the saved file has the exact release hash',{skip:process.env.ANDROID_APK_PUBLIC_CHECK!=='1',timeout:300000},async()=>{
 const {androidRelease:apk}=await import('./release.ts');
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
  await page.goto('https://flip-manager-ai.vercel.app/android',{waitUntil:'domcontentloaded'});
  const pending=page.waitForEvent('download',{timeout:30000});await page.getByRole('link',{name:'Pobierz APK · 214 MB',exact:true}).click();
  const download=await pending;assert.equal(download.suggestedFilename(),apk.filename);
  const path=await download.path();assert.equal(await download.failure(),null);assert.ok(path);
  const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(path)){bytes+=chunk.byteLength;hash.update(chunk);}
  assert.equal(bytes,apk.bytes);assert.equal(hash.digest('hex'),apk.sha256);
  console.log(`Chrome download completed: ${apk.filename}, ${bytes} bytes, SHA-256 ${apk.sha256}`);
 }finally{await browser.close();}
});
