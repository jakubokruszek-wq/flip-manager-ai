import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { investmentPath,testListingAllowed } from "./test-identity";
const root=process.cwd();
function files(p:string):string[]{return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(p,e.name)):[path.join(p,e.name)]);}
test("Finder and real Deal Room cannot expose removed demo or honor obsolete deployment switches",()=>{
 const finder=fs.readFileSync('app/(app)/flip-finder/page.tsx','utf8');assert.doesNotMatch(finder,/TestFinder|DEAL_ROOM_TEST|testCases|Przygotuj/);
 const page=fs.readFileSync('app/(app)/deals/[listingId]/page.tsx','utf8');assert.match(page,/isTestListingId\(listingId\)\)notFound/);
 assert.equal(testListingAllowed('deadbeef-0000-4000-8000-000000000000','any'),false);assert.equal(investmentPath('22222222-2222-4222-8222-222222222222'),'/api/flip-finder/listings/22222222-2222-4222-8222-222222222222/investment');
});
test("all application demo routes removed; no production module imports fixtures or TEST activation flags",()=>{
 assert.equal(files(path.join(root,'app/api')).some(p=>p.includes('/deal-room/test/')&&p.endsWith('route.ts')),false);
 for(const dir of ['app','features/investment-os'])for(const p of files(path.join(root,dir)).filter(p=>/\.tsx?$/.test(p)&&!p.includes('/test-fixtures/')&&!p.includes('.test.')&&!p.includes('.browser.'))){
  const text=fs.readFileSync(p,'utf8');assert.doesNotMatch(text,/DEAL_ROOM_TEST_|from ["'][^"']*test-fixtures/,'unexpected production dependency: '+path.relative(root,p));
 }
});
