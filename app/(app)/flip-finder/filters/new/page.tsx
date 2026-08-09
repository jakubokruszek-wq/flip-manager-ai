import { PageHeader } from "@/components/ui/page-header";
import { SearchFilterForm } from "@/features/flip-finder/components/search-filter-form";
export const metadata = { title: "Nowy filtr" };
export default function Page() { return <div className="space-y-6"><PageHeader title="Nowy filtr" description="Określ, które oferty ma w przyszłości wyszukiwać Flip Finder."/><SearchFilterForm/></div>; }
