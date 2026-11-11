import type { Metadata } from "next";
import { WorkspaceList } from "@/features/property-workspace/workspace-list";
export const propertiesMetadata: Metadata = { title: "Nieruchomości" };
export function PropertiesPage() { return <WorkspaceList />; }
