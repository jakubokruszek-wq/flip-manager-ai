import assert from "node:assert/strict";
import test from "node:test";
import { filterAlertsByPreferences } from "./preferences.ts";
import { DEFAULT_ALERT_PREFERENCES, type InvestmentAlert } from "./types.ts";
const alert:InvestmentAlert={id:"1",eventKey:"one",type:"facebook_opportunity",listingId:"l",title:"T",source:"facebook",sellerType:"private",price:300000,area:50,neighborhood:"Teofilów",city:"Łódź",pricePerSqm:6000,flipScore:80,opportunityScore:90,condition:"renovation",groupName:null,flags:[],detectedAt:"2026-08-09T12:00:00Z",readAt:null,detailsUrl:"/x",originalUrl:null};
test("applies city, neighborhood and financial limits",()=>assert.equal(filterAlertsByPreferences([alert],{...DEFAULT_ALERT_PREFERENCES,lodzOnly:true,neighborhoods:["Teofilów"],maxPrice:310000,maxPricePerSqm:6100}).length,1));
test("applies Opportunity threshold",()=>assert.equal(filterAlertsByPreferences([alert],{...DEFAULT_ALERT_PREFERENCES,minOpportunityScore:95}).length,0));
test("facebook-only excludes other sources",()=>assert.equal(filterAlertsByPreferences([{...alert,source:"olx"}],{...DEFAULT_ALERT_PREFERENCES,facebookOnly:true}).length,0));
test("private-only uses seller type, not alert type",()=>assert.equal(filterAlertsByPreferences([{...alert,type:"high_flip_score",flipScore:90,sellerType:"private"},{...alert,id:"2",sellerType:"agency"}],{...DEFAULT_ALERT_PREFERENCES,privateOnly:true}).length,1));
