import test from "node:test";
import assert from "node:assert/strict";
import {exactStream} from "./exact-stream.ts";
test("the final byte completes a download without waiting for upstream EOF", {timeout:1000}, async () => {
 let cancelled=false;
 const source=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3]));},cancel(){cancelled=true;}});
 assert.deepEqual([...new Uint8Array(await new Response(exactStream(source,3)).arrayBuffer())],[1,2,3]);
 assert.equal(cancelled,true);
});
test("short or oversized bodies fail instead of reporting a complete APK", async () => {
 for(const values of [[1,2],[1,2,3,4]]){
  const source=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(values));c.close();}});
  await assert.rejects(()=>new Response(exactStream(source,3)).arrayBuffer(),/APK_(INCOMPLETE|EXCESS)_BODY/);
 }
});
test("cancelling a phone download cancels its source and a pending read", async () => {
 let cancelled=false;
 const stream=exactStream(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),10);
 const reader=stream.getReader(),pending=reader.read();await reader.cancel("PHONE_DISCONNECTED");assert.equal((await pending).done,true);assert.equal(cancelled,true);reader.releaseLock();
});
