import assert from "node:assert/strict";
import test from "node:test";
import {hasAcceptedRadarStandard} from "./accepted-standard.ts";
const base={title:"Mieszkanie",description:"Świeżo po generalnym remoncie, gotowe do zamieszkania.",marketType:"secondary" as const,renovationStatus:"fresh_renovation" as const};
test("only positive own-apartment proof can show a stored category",()=>{
  assert.equal(hasAcceptedRadarStandard(base),true);
  for(const description of [null,"Wysoki standard.","Odświeżone mieszkanie.","Po remoncie.","Planowane zakończenie remontu.","Łazienka świeżo po generalnym remoncie. Gotowe do zamieszkania."]){assert.equal(hasAcceptedRadarStandard({...base,description}),false,String(description));}
  assert.equal(hasAcceptedRadarStandard({...base,verificationIssues:["qualification"]}),false);
});
test("finished high standard and completed turnkey primary have separate evidence gates",()=>{
  assert.equal(hasAcceptedRadarStandard({...base,renovationStatus:"turnkey_finish",description:"W pełni wykończone, wysoki standard, gotowe do zamieszkania."}),true);
  assert.equal(hasAcceptedRadarStandard({...base,renovationStatus:"turnkey_finish",description:"Gotowe do zamieszkania."}),false);
  assert.equal(hasAcceptedRadarStandard({...base,marketType:"primary",renovationStatus:"turnkey_finish",description:"Mieszkanie wykończone pod klucz, gotowe do zamieszkania."}),true);
  assert.equal(hasAcceptedRadarStandard({...base,marketType:"primary",renovationStatus:"turnkey_finish",description:"Opcjonalne wykończenie pod klucz za dopłatą."}),false);
});
