import { Suspense } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { SearchFiltersPage } from "@/features/flip-finder/components/search-filters-page";
export const metadata = { title: "Filtry wyszukiwania" };
export default function Page() { return <div className="space-y-6"><PageHeader title="Filtry wyszukiwania" description="Konfiguracje ograniczające przyszłe skanowanie ofert."/><Suspense fallback={<p>Ładowanie filtrów…</p>}><SearchFiltersPage/></Suspense></div>; }
