import { PageHeader } from "@/components/ui/page-header";
import { SearchFilterForm } from "@/features/flip-finder/components/search-filter-form";
export const metadata = { title: "Edytuj filtr" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <div className="space-y-6"><PageHeader title="Edytuj filtr" description="Zmień konfigurację wyszukiwania ofert."/><SearchFilterForm filterId={id}/></div>; }
