import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
let denied = false;
mock.module('@/features/auth/operator', { namedExports: { requireOperator: async () => { if (denied) throw Error('denied'); return {id:'operator'}; }, operatorAuthorizationResponse: () => Response.json({message:'denied'},{status:401}) } });
const districts = await import('./districts/route.ts');
const nearby = await import('./nearby/route.ts');
const geocode = await import('./geocode/route.ts');
const request = (path: string) => new Request('https://localhost/api/price-radar/rcn/'+path);
test('districts, radius and geocode authorize before exposing validation or data',async()=>{
 denied=true;
 try { for(const handler of [districts.GET,nearby.GET,geocode.GET])assert.equal((await handler(request('invalid'))).status,401); }
 finally {denied=false;}
});
test('district API serves five real geographic groups, private-cache and metrage filtering',async()=>{
 const response=await districts.GET(request('districts?area=medium'));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
 const data=await response.json();assert.equal(data.districts.length,5);assert.equal(data.areaBand,'medium');assert(data.observationCount>1000);assert(data.districts.every((g:{examples:Array<{area:number}>})=>g.examples.every(r=>r.area>=35&&r.area<50)));
 assert.equal((await districts.GET(request('districts?area=wrong'))).status,400);
});
test('typed Tatrzańska center and radius use actual city dataset; unknown address is not fabricated',async()=>{
 const coded=await geocode.GET(request('geocode?address='+encodeURIComponent('Tatrzańska 94')));assert.equal(coded.status,200);const center=await coded.json();assert.equal(center.precision,'address');
 const result=await nearby.GET(request(`nearby?latitude=${center.latitude}&longitude=${center.longitude}&radius=1000`));assert.equal(result.status,200);const body=await result.json();assert(body.strongCandidateCount>0);assert(body.rows.every((row:{distanceMeters:number;strongSignal:boolean})=>row.distanceMeters<=1000&&row.strongSignal));
 assert.equal((await nearby.GET(request('nearby?latitude=52.2&longitude=21&radius=1000'))).status,400);
 assert.equal((await geocode.GET(request('geocode?address=Nieistniejaca999999999'))).status,404);
 assert(!JSON.stringify(body).includes('LOK_ID_LOKALU'));
});
