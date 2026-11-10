import { WorkspacePage } from "@/features/property-workspace/workspace-page";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { return <WorkspacePage id={(await params).id} />; }
