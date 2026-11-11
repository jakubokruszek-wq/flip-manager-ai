"use client";
import { useRouter } from "next/navigation";
import { PropertyDeleteControl } from "@/features/properties/components/property-delete-control";
export function DeleteWorkspaceCard({ propertyId }: { propertyId: string }) { const router = useRouter(); return <PropertyDeleteControl propertyId={propertyId} onDeleted={() => router.refresh()} />; }
