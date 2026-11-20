import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_FACEBOOK_INBOX_FILTERS, filterFacebookInbox, opportunityLabel, sortFacebookInbox } from "./facebook-inbox.ts";
import type { FacebookWatcherListing } from "./types.ts";

const base = { listingId:"1",title:"Mieszkanie Teofilów",city:"Łódź",district:"Bałuty",neighborhood:"Teofilów",street:"Rojna",price:300000,pricePerM2:null,pricePerSqm:6000,area:50,rooms:2,floor:2,totalFloors:null,marketType:null,sellerType:"private",condition:"renovation",description:"Bezpośrednio",originalUrl:"https://facebook.com/post",images:[],confidence:1,flags:[],status:"active",workflowStatus:"new",readAt:null,importedAt:"2026-08-09T10:00:00Z",publishedAt:"2026-08-08T10:00:00Z",groupName:"Łódź Okazje",opportunityScore:90,flipScore:85,potentialProfit:50000,isNew:true,highPriority:true,crossSourceMatch:false,crossSourceLinks:[],source:"facebook" } satisfies FacebookWatcherListing;

test("searches title, neighborhood and group case-insensitively",()=>{ const item={...base,groupName:"Łódź Okazje"}; assert.equal(filterFacebookInbox([item],"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,query:"teofilÓW"}).length,1); assert.equal(filterFacebookInbox([item],"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,query:"okazje"}).length,1); });
test("filters workflow status",()=>assert.equal(filterFacebookInbox([base],"review",EMPTY_FACEBOOK_INBOX_FILTERS).length,0));
test("applies numeric and seller filters",()=>assert.equal(filterFacebookInbox([base],"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,maxPrice:310000,maxPricePerSqm:6100,rooms:2,sellerType:"private"}).length,1));
test("newest uses published date and falls back to import date",()=>{ const newerImport={...base,listingId:"2",publishedAt:null,importedAt:"2026-08-09T12:00:00Z"}; assert.equal(sortFacebookInbox([base,newerImport],"newest")[0].listingId,"2"); });
test("sorts scores and nullable prices",()=>{ const low={...base,listingId:"2",opportunityScore:70,pricePerSqm:null}; assert.equal(sortFacebookInbox([low,base],"opportunity")[0].listingId,"1"); assert.equal(sortFacebookInbox([low,base],"price_per_sqm")[0].listingId,"1"); });
test("flip sorts by flipScore descending",()=>{ const lower={...base,listingId:"2",flipScore:40}; assert.deepEqual(sortFacebookInbox([lower,base],"flip").map(i=>i.listingId),["1","2"]); });
test("price sorts ascending and pushes an unknown price to the end",()=>{ const cheaper={...base,listingId:"2",price:150000}; const unknown={...base,listingId:"3",price:null}; assert.deepEqual(sortFacebookInbox([base,unknown,cheaper],"price").map(i=>i.listingId),["2","1","3"]); });
test("profit sorts descending and pushes an unknown profit to the end",()=>{ const lowerProfit={...base,listingId:"2",potentialProfit:10000}; const unknownProfit={...base,listingId:"3",potentialProfit:null}; assert.deepEqual(sortFacebookInbox([lowerProfit,unknownProfit,base],"profit").map(i=>i.listingId),["1","2","3"]); });
test("maps opportunity thresholds",()=>{ assert.equal(opportunityLabel(90),"Wyjątkowa okazja"); assert.equal(opportunityLabel(85),"Bardzo dobra"); assert.equal(opportunityLabel(75),"Warta analizy"); assert.equal(opportunityLabel(74),null); });

test("unit-price ceiling keeps missing values, includes the boundary and rejects only known values above it",()=>{
  const items=[{...base,listingId:"unknown",pricePerSqm:null},{...base,listingId:"at",pricePerSqm:7000},{...base,listingId:"above",pricePerSqm:7001}];
  assert.deepEqual(filterFacebookInbox(items,"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,maxPricePerSqm:7000}).map(item=>item.listingId),["unknown","at"]);
  assert.deepEqual(filterFacebookInbox(items,"all",{...EMPTY_FACEBOOK_INBOX_FILTERS,maxPricePerSqm:7000,minArea:60}).map(item=>item.listingId),[],"other selected conditions still apply to an unknown unit price");
});

test("manual rejection disappears from the default inbox but remains recoverable in rejected",()=>{
 const rejected={...base,listingId:"rejected",workflowStatus:"rejected" as const};
 const finderRejected={...base,listingId:"finder-rejected",finderStatus:"REJECTED" as const};
 assert.deepEqual(filterFacebookInbox([base,rejected,finderRejected],"all",EMPTY_FACEBOOK_INBOX_FILTERS).map(i=>i.listingId),["1","finder-rejected"]);
 assert.deepEqual(filterFacebookInbox([base,rejected],"rejected",EMPTY_FACEBOOK_INBOX_FILTERS).map(i=>i.listingId),["rejected"]);
 assert.equal(filterFacebookInbox([{...rejected,workflowStatus:"review"}],"all",EMPTY_FACEBOOK_INBOX_FILTERS).length,1);
});


test("missing property facts stay visible under selected filters while known mismatches are rejected",()=>{
 const filters={...EMPTY_FACEBOOK_INBOX_FILTERS,minPrice:200000,maxPrice:400000,minArea:40,maxArea:60,minFloor:1,maxFloor:4,minProfit:20000,roomOptions:[2],excludeGroundFloor:true,excludeTopFloor:true,marketType:"secondary" as const,sellerType:"private" as const,condition:"renovation" as const};
 const missing={...base,listingId:"missing",price:null,area:null,rooms:null,floor:null,totalFloors:null,potentialProfit:null,marketType:null,sellerType:null,condition:null};
 const known={...base,listingId:"known",marketType:"secondary" as const,totalFloors:5};
 const badPrice={...known,listingId:"expensive",price:500000};
 const badArea={...missing,listingId:"small",area:20};
 const top={...known,listingId:"top",floor:5};
 assert.deepEqual(filterFacebookInbox([missing,known,badPrice,badArea,top],"all",filters).map(x=>x.listingId),["missing","known"]);
 assert.equal(filterFacebookInbox([{...missing,area:50}],"all",filters).length,1,"missing price plus known matching area remains visible");
 assert.equal(filterFacebookInbox([{...missing,rooms:3}],"all",filters).length,0);
 assert.equal(filterFacebookInbox([{...missing,floor:0}],"all",filters).length,0);
 assert.equal(filterFacebookInbox([{...missing,sellerType:"agency"}],"all",filters).length,0);
 assert.equal(filterFacebookInbox([{...missing,workflowStatus:"rejected"}],"all",filters).length,0);
 assert.equal(filterFacebookInbox([missing],"all",{...filters,query:"nonexistent-street"}).length,0);
});
