import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEST_CASES = [
  { key: "opportunity", title: "TEST · Łódź — wysoka marża", price: 200000 },
  { key: "thin", title: "TEST · Łódź — niewielka marża", price: 340000 },
  { key: "reject", title: "TEST · Łódź — ryzykowny zakup", price: 680000 },
] as const;
/** Server-side configuration only. Never uses email or user-editable metadata. */
export function testModeAllowed(actorId: string, env: Readonly<Partial<Record<"DEAL_ROOM_TEST_ENABLED" | "DEAL_ROOM_QA_ENABLED" | "VERCEL_ENV" | "DEAL_ROOM_TEST_DATABASE_ORIGIN" | "NEXT_PUBLIC_SUPABASE_URL" | "DEAL_ROOM_TEST_OPERATOR_IDS", string>>> = process.env): boolean {
  if (env.DEAL_ROOM_TEST_ENABLED !== "true" || env.DEAL_ROOM_QA_ENABLED !== "true" || env.VERCEL_ENV === "production" || !UUID.test(actorId)) return false;
  const configured = env.DEAL_ROOM_TEST_DATABASE_ORIGIN;
  try {
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (!configured || configured !== url.origin || url.username || url.password || url.search || url.hash || url.pathname !== "/") return false;
    if (url.hostname.includes("zmuisdirvfcxrvtbvrle")) return false;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) return false;
  } catch { return false; }
  return (env.DEAL_ROOM_TEST_OPERATOR_IDS ?? "").split(",").map(s => s.trim()).filter(s => UUID.test(s)).includes(actorId);
}
export function testCases(actorId: string) {
  return TEST_CASES.map(c => {
    const hash = createHash("sha256").update(`deal-room-test-v1:${actorId}:${c.key}`).digest("hex");
    return { ...c, id: `deadbeef-${hash.slice(0,4)}-4${hash.slice(4,7)}-8${hash.slice(7,10)}-${hash.slice(10,22)}` };
  });
}
export function testListingAllowed(id: string, actorId: string): boolean {
  return !id.toLowerCase().startsWith("deadbeef-") || (testModeAllowed(actorId) && testCases(actorId).some(c => c.id === id));
}
