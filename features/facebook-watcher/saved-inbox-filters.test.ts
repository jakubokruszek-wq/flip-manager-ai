import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_FACEBOOK_INBOX_FILTERS, filterFacebookInbox } from "./facebook-inbox.ts";
import { readSavedInboxFilters, inboxRangeError } from "./saved-inbox-filters.ts";
import type { FacebookWatcherListing } from "./types.ts";

test("saved ranges and multi-room choices survive serialization", () => {
  const filters = { ...EMPTY_FACEBOOK_INBOX_FILTERS, minPrice: 250000, maxPrice: 450000, minArea: 35.5, maxArea: 62, minFloor: 1, maxFloor: 4, roomOptions: [2,3], excludeGroundFloor: true, query: "Bałuty" };
  assert.deepEqual(readSavedInboxFilters(JSON.stringify({version:1,filters})), filters);
});
test("corrupt, unsupported and malicious saved values cannot break filtering", () => {
  for (const value of [null,"no json",JSON.stringify({version:2,filters:{}}),JSON.stringify({version:1,filters:[]})]) assert.equal(readSavedInboxFilters(value),null);
  const parsed = readSavedInboxFilters(JSON.stringify({version:1,filters:{minPrice:-2,maxPrice:"400000",roomOptions:[2,2,9,"3"],sellerType:"broken",excludeGroundFloor:"true"}}));
  assert.equal(parsed?.minPrice,null);assert.equal(parsed?.maxPrice,null);assert.deepEqual(parsed?.roomOptions,[2]);assert.equal(parsed?.sellerType,"all");assert.equal(parsed?.excludeGroundFloor,false);
});
test("range bounds are inclusive and unknown constrained values do not pass", () => {
  const base = { listingId:"a",title:"A",description:null,street:null,neighborhood:null,groupName:null,district:null,price:300000,pricePerSqm:6000,area:50,rooms:2,floor:2,totalFloors:4,flipScore:50,opportunityScore:50,potentialProfit:30000 } as FacebookWatcherListing;
  const filters = {...EMPTY_FACEBOOK_INBOX_FILTERS,minPrice:300000,maxPrice:300000,minArea:50,maxArea:50,minFloor:2,maxFloor:2,roomOptions:[2,3],minProfit:30000};
  assert.equal(filterFacebookInbox([base],"all",filters).length,1);
  for (const patch of [{price:null},{price:300001},{price:299999},{area:null},{area:50.01},{floor:null},{floor:1},{rooms:1},{potentialProfit:null}]) assert.equal(filterFacebookInbox([{...base,...patch}],"all",filters).length,0,JSON.stringify(patch));
  assert.equal(filterFacebookInbox([base],"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,excludeTopFloor:true}).length,1);
  assert.equal(filterFacebookInbox([{...base,totalFloors:null}],"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,excludeTopFloor:true}).length,0);
});
test("inverted ranges produce a useful error and can be cleared", () => {
  assert.match(inboxRangeError({...EMPTY_FACEBOOK_INBOX_FILTERS,minArea:70,maxArea:40})??"",/Powierzchnia/);
  assert.equal(inboxRangeError(EMPTY_FACEBOOK_INBOX_FILTERS),null);
});
