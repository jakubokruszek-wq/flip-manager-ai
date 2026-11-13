import test from "node:test";
import assert from "node:assert/strict";
import { downloadApk } from "./download.ts";
import { androidRelease as apk, androidRelease087, androidZip105 } from "./release.ts";
const url = `https://example.test${apk.path}`;
test("public APK HEAD is exact and never buffers or downloads the file", async () => {
 const response=await downloadApk(new Request(url,{method:"HEAD"}));assert.equal(response.status,200);assert.equal(response.headers.get("content-length"),String(apk.bytes));assert.equal(response.headers.get("accept-ranges"),"bytes");assert.match(response.headers.get("content-disposition")!,/attachment.*\.apk/);
});
test("APK is streamed from the fixed release and resumes exact byte ranges", async context => {
 let received: { url: string; init?: RequestInit } | null=null;
 context.mock.method(globalThis,"fetch",async (input: string | URL | Request, init?:RequestInit)=>{received={url:String(input),init};return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}}),{status:206,headers:{"content-range":`bytes 4-6/${apk.bytes}`,"content-length":"3"}});});
 const response=await downloadApk(new Request(url+"?url=https://untrusted.test",{headers:{range:"bytes=4-6"}}));assert.equal(response.status,206);assert.equal(received!.url,apk.source);assert.deepEqual(received!.init?.headers,{Range:"bytes=4-6"});assert.equal(response.headers.get("content-range"),`bytes 4-6/${apk.bytes}`);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);
});
test("bad ranges never request upstream; different If-Range restarts the full file", async context => {
 let calls=0;context.mock.method(globalThis,"fetch",async (_:unknown,init?:RequestInit)=>{calls++;assert.deepEqual(init?.headers,{});return new Response(new Uint8Array([1]),{headers:{"content-length":String(apk.bytes)}});});
 for(const range of ["bytes=9-2","bytes=0-1,8-9","bytes=-0",`bytes=${apk.bytes}-`,`bytes=9007199254740993-`])assert.equal((await downloadApk(new Request(url,{headers:{range}}))).status,416);
 assert.equal(calls,0);const response=await downloadApk(new Request(url,{headers:{range:"bytes=4-6","if-range":"old-file"}}));assert.equal(response.status,200);await response.body?.cancel();assert.equal(calls,1);
});
test("upstream errors or a wrong release size are never saved as an APK",async context=>{
 context.mock.method(console,"error",()=>{});
 for(const upstream of [new Response("error",{status:429}),new Response("oops",{headers:{"content-length":"4"}}),new Response("abc",{status:206,headers:{"content-length":"3","content-range":`bytes 3-5/${apk.bytes}`}})]) {
  context.mock.method(globalThis,"fetch",async()=>upstream);const response=await downloadApk(new Request(url,{headers:{range:"bytes=4-6"}}));assert.equal(response.status,503);assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("retry-after"),"30");
 }
});

test("the old versioned URL remains pinned when the latest release changes",async()=>{
 const response=await downloadApk(new Request(`https://example.test${androidRelease087.path}`,{method:"HEAD"}),androidRelease087);assert.equal(response.headers.get("content-length"),"213802477");assert.match(response.headers.get("content-disposition")!,/flip-watcher-0\.5\.87-arm64\.apk/);assert.match(response.headers.get("etag")!,/c2c4b24e/);
});

test("ZIP alternative uses its pinned metadata and ZIP MIME without changing APK headers",async()=>{
 const zip=await downloadApk(new Request(`https://example.test${androidZip105.path}`,{method:"HEAD"}),androidZip105);
 assert.equal(zip.headers.get("content-type"),"application/zip");
 assert.equal(zip.headers.get("content-length"),String(androidZip105.bytes));
 assert.match(zip.headers.get("content-disposition")!,/flip-watcher-0\.5\.105-arm64\.zip/);
 const normal=await downloadApk(new Request(url,{method:"HEAD"}));
 assert.equal(normal.headers.get("content-type"),"application/vnd.android.package-archive");
});
