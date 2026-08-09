import assert from "node:assert/strict";
import test from "node:test";
import { safeFacebookGroupAdapter } from "./adapter.ts";
import type { WatchedFacebookGroup } from "./types.ts";
const group:WatchedFacebookGroup={id:"1",name:"Łódź",url:"https://facebook.com/groups/1",city:"Łódź",district:null,neighborhood:null,priority:"high",keywords:[],enabled:true,accessStatus:"MANUAL_IMPORT",lastCheckedAt:null,importedPosts:0,newToday:0,opportunities:0,lastError:null};
test("safe adapter never scrapes protected Facebook groups",async()=>{const result=await safeFacebookGroupAdapter.checkGroup(group);assert.equal(result.status,"MANUAL_IMPORT");assert.deepEqual(result.posts,[]);assert.match(result.error??"",/ręcznego importu/);});
