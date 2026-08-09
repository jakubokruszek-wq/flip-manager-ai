import { FilterResultsPage } from "@/features/flip-finder/components/filter-results-page";
export default async function Page({ params }: { params: Promise<{ id:string }> }) { return <FilterResultsPage id={(await params).id}/>; }
