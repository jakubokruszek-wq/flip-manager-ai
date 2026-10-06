import { FlipFinderPage } from "@/features/flip-finder/components/flip-finder-page";
import { Suspense } from "react";
export const metadata = { title: "Flip Finder" };
export default function Page() {
  return <Suspense><FlipFinderPage /></Suspense>;
}
