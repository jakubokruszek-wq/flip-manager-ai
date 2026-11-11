"use client";
import { useRouter } from "next/navigation";
import { PropertyDialog } from "@/features/properties/components/property-dialog";
import type { PropertyWithInvestmentAnalysis } from "@/features/properties/types";
export function SourceDetails({ property }: { property: PropertyWithInvestmentAnalysis }) {
 const router = useRouter();
 return <PropertyDialog workspaceManaged property={property} onUpdated={() => router.refresh()} trigger={<button type="button" className="min-h-12 rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground">Otwórz i edytuj dane oferty</button>} />;
}
