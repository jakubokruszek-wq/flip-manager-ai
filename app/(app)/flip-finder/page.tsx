import { TestFinder } from "@/features/investment-os/components/test-finder";
import { testCases, testModeAllowed } from "@/features/investment-os/test-mode";
import { requireOperator, OperatorAuthorizationError } from "@/features/auth/operator";
import { FlipFinderPage } from "@/features/flip-finder/components/flip-finder-page";
import { Suspense } from "react";
export const dynamic = "force-dynamic";
export const metadata = { title: "Flip Finder" };
export default async function Page() {
  let cases: ReturnType<typeof testCases> = [];
  if (process.env.DEAL_ROOM_TEST_ENABLED === "true") {
    try { const actor = await requireOperator(); if (testModeAllowed(actor.id)) cases = testCases(actor.id); }
    catch (error) { if (!(error instanceof OperatorAuthorizationError)) throw error; }
  }
  return <>{cases.length ? <TestFinder cases={cases} /> : null}<Suspense><FlipFinderPage /></Suspense></>;
}
