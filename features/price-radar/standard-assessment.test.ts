import assert from "node:assert/strict";
import test from "node:test";
import { assessRadarSavedStandard } from "./standard-assessment.ts";
import { hasCategoryBFinishEvidence, qualifyRadarCandidate, type QualificationCandidate } from "./qualification.ts";

const candidate=(description:string):QualificationCandidate=>({source:"otodom",externalListingId:"test",originalUrl:"https://example.test/1",normalizedUrl:"https://example.test/1",title:"Mieszkanie w bloku, Łódź Górna",description,price:500000,area:50,pricePerSqm:10000,rooms:2,city:"Łódź",district:"Górna",buildingType:"blok",marketType:"secondary",rawPayload:{detailVerified:true},contentHash:"test"});

// Sanitized examples distilled from saved queue wording. These are regression
// cases, not automatically approved operator decisions or model training.
const cases = [
  ["Mieszkanie świeżo po generalnym remoncie, gotowe do zamieszkania.","fresh_renovation"],
  ["Mieszkanie po generalnym remoncie. Wysoki standard. Gotowe do zamieszkania.","ready_high_standard"],
  ["Mieszkanie wykończone w wysokim standardzie, gotowe do zamieszkania.","ready_high_standard"],
  ["Mieszkanie po generalnym remoncie, gotowe do zamieszkania.","renovated_unknown_recency"],
  ["Wysoki standard pod klucz. PLANOWANE ZAKOŃCZENIE REMONTU DO KOŃCA LISTOPADA.","needs_work"],
  ["Mieszkanie w pełni wykończone, gotowe do zamieszkania, wysoki standard. Planowane zakończenie remontu do końca listopada.","needs_work"],
  ["Cechą inwestycji jest wysoki standard. Zakończenie inwestycji planowane w przyszłości.","insufficient"],
  ["Mieszkanie wymaga generalnego remontu, choć jest reklamowane jako wysoki standard.","needs_work"],
  ["Klatka schodowa po generalnym remoncie. Mieszkanie do odświeżenia.","insufficient"],
  ["Mieszkanie nie wymaga remontu.","insufficient"],
] as const;
for(const [description,expected] of cases) test(`saved standard: ${description}`,()=>assert.equal(assessRadarSavedStandard(null,description).category,expected));

test("completed general renovation plus explicit standard and readiness qualifies B without inventing renovation recency",()=>{
  const description="Mieszkanie po generalnym remoncie, w wysokim standardzie, gotowe do zamieszkania.";
  assert.equal(hasCategoryBFinishEvidence(null,description),true);
  const result=qualifyRadarCandidate(candidate(description));assert.equal(result.qualified,true);
  if(result.qualified)assert.equal(result.renovationStatus,"turnkey_finish");
  assert.equal(qualifyRadarCandidate({...candidate(description),rawPayload:{detailVerified:false}}).qualified,false,"saved evidence must not bypass source confirmation");
});
test("future completion cannot be approved from conflicting present-tense marketing",()=>{
  const description="W pełni wykończone mieszkanie, gotowe do zamieszkania, wysoki standard. PLANOWANE ZAKOŃCZENIE REMONTU DO KOŃCA LISTOPADA.";
  assert.equal(hasCategoryBFinishEvidence(null,description),false);
  assert.equal(qualifyRadarCandidate(candidate(description)).qualified,false);
});
test("a confirmed negation of general renovation never becomes category B",()=>{
  assert.equal(hasCategoryBFinishEvidence(null,"Mieszkanie nie jest po generalnym remoncie. Gotowe do zamieszkania, wysoki standard."),false);
});

test("a general renovation of only the bathroom cannot establish completed whole-apartment finish",()=>{
  const description="Łazienka po generalnym remoncie. Mieszkanie w wysokim standardzie, gotowe do zamieszkania.";
  assert.equal(hasCategoryBFinishEvidence(null,description),false);
  assert.equal(qualifyRadarCandidate(candidate(description)).qualified,false);
});
