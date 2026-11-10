import Link from "next/link";
import { notFound } from "next/navigation";
import { getProperties } from "@/services/properties.service";
import { SourceDetails } from "@/features/property-workspace/source-details";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const property = (await getProperties()).find(p => p.id === id);
  if (!property) notFound();
  return <div className="space-y-5"><Link href={`/properties/${id}`} className="text-primary underline">← Karta nieruchomości</Link><h1 className="text-2xl font-bold">{property.title || property.address}</h1><SourceDetails property={property} /></div>;
}
