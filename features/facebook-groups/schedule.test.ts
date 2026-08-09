import assert from "node:assert/strict";
import test from "node:test";
import { isFacebookGroupDue } from "./schedule.ts";
import type { WatchedFacebookGroup } from "./types.ts";
const group:WatchedFacebookGroup={id:"1",name:"G",url:"https://facebook.com/groups/1",city:"Łódź",district:null,neighborhood:null,priority:"high",keywords:[],enabled:true,accessStatus:"MANUAL_IMPORT",lastCheckedAt:"2026-08-09T12:00:00Z",importedPosts:0,newToday:0,opportunities:0,lastError:null};
test("priority controls a non-aggressive due interval",()=>{assert.equal(isFacebookGroupDue(group,Date.parse("2026-08-09T12:04:00Z")),false);assert.equal(isFacebookGroupDue(group,Date.parse("2026-08-09T12:05:00Z")),true);assert.equal(isFacebookGroupDue({...group,priority:"low"},Date.parse("2026-08-09T12:30:00Z")),false);});
