import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { downloadApk } from "./download.ts";
import { androidRelease as apk } from "./release.ts";

test("real release streams completely and supports native resume", { skip: process.env.ANDROID_APK_LIVE_CHECK !== "1", timeout: 180000 }, async () => {
 const response=await downloadApk(new Request(`https://example.test${apk.path}`));assert.equal(response.status,200,await failure(response));
 const hash=createHash("sha256");let bytes=0;for await(const chunk of response.body!){bytes+=chunk.byteLength;hash.update(chunk);}assert.equal(bytes,apk.bytes);assert.equal(hash.digest("hex"),apk.sha256);
 const start=apk.bytes-65536;const resumed=await downloadApk(new Request(`https://example.test${apk.path}`,{headers:{Range:`bytes=${start}-`}}));assert.equal(resumed.status,206,await failure(resumed));assert.equal(resumed.headers.get("content-range"),`bytes ${start}-${apk.bytes-1}/${apk.bytes}`);assert.equal((await resumed.arrayBuffer()).byteLength,65536);
});
async function failure(response:Response){return response.status>=400?await response.text():String(response.status);}
