import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEST_CASES = [
  { key: "opportunity", title: "TEST · Łódź — wysoka marża", price: 200000 },
  { key: "thin", title: "TEST · Łódź — niewielka marża", price: 340000 },
  { key: "reject", title: "TEST · Łódź — ryzykowny zakup", price: 680000 },
] as const;
/** New storage contract must be explicitly approved/configured; independent of real Deal Room flags. */
export function testModeAllowed(actorId:string, env:Readonly<Record<string,string|undefined>>={
 DEAL_ROOM_TEST_ENABLED:process.env.DEAL_ROOM_TEST_ENABLED,
 DEAL_ROOM_TEST_STORAGE_VERSION:process.env.DEAL_ROOM_TEST_STORAGE_VERSION,
 DEAL_ROOM_TEST_OPERATOR_IDS:process.env.DEAL_ROOM_TEST_OPERATOR_IDS,
}):boolean {
 return env.DEAL_ROOM_TEST_ENABLED==="true" && env.DEAL_ROOM_TEST_STORAGE_VERSION==="1" && UUID.test(actorId) && (env.DEAL_ROOM_TEST_OPERATOR_IDS??"").split(",").map(s=>s.trim()).filter(s=>UUID.test(s)).includes(actorId);
}
export function testCases(actorId: string) {
  return TEST_CASES.map(c => {
    const hash = createHash("sha256").update(`deal-room-test-v1:${actorId}:${c.key}`).digest("hex");
    return { ...c, id: `deadbeef-${hash.slice(0,4)}-4${hash.slice(4,7)}-8${hash.slice(7,10)}-${hash.slice(10,22)}` };
  });
}
/** Normal investment endpoints NEVER accept virtual TEST identifiers, even with TEST on. */
export function testListingAllowed(id:string, _actorId:string):boolean { void _actorId; return !id.toLowerCase().startsWith("deadbeef-"); }
