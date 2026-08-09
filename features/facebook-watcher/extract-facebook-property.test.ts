import assert from "node:assert/strict";
import test from "node:test";
import { extractFacebookProperty } from "./extract-facebook-property.ts";

test("Teofilów M3", async()=>{ const value=await extractFacebookProperty({postText:"Sprzedam M3 na Teofilowie 46m2 289 tys bez pośredników"}); assert.equal(value.neighborhood,"Teofilów"); assert.equal(value.district,"Bałuty"); assert.equal(value.area,46); assert.equal(value.rooms,2); assert.equal(value.price,289000); assert.equal(value.sellerType,"private"); });
test("Radogoszcz Zachód", async()=>{ const value=await extractFacebookProperty({postText:"Radogoszcz Zachód, 3 pokoje, 58 m2, do generalnego remontu"}); assert.equal(value.neighborhood,"Radogoszcz Zachód"); assert.equal(value.rooms,3); assert.equal(value.condition,"renovation"); });
test("brak ceny", async()=>assert.equal((await extractFacebookProperty({postText:"Mieszkanie na Teofilowie 46 m2"})).price,null));
test("brak lokalizacji", async()=>assert.equal((await extractFacebookProperty({postText:"Sprzedam 2 pokoje, 42 m2"})).city,null));
test("flagi nie zmieniają danych finansowych", async()=>{ const value=await extractFacebookProperty({postText:"Pilnie, okazja, prywatnie, 40 m2"}); assert.deepEqual(value.flags,["pilnie","okazja","prywatnie"]); assert.equal(value.price,null); });
test("dzielnica nie staje się osiedlem", async()=>{ const value=await extractFacebookProperty({postText:"Mieszkanie Bałuty, 45 m2"}); assert.equal(value.district,"Bałuty"); assert.equal(value.neighborhood,null); });
