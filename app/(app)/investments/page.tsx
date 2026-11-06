import Link from "next/link";
import { getProperties } from "@/services/properties.service";

export const metadata = { title: "Inwestycje" };

const investmentStatuses = new Set(["acquired", "renovation", "listed", "sold"]);
const labels: Record<string, string> = {
  acquired: "Kupiona", renovation: "Remont", listed: "W sprzedaży", sold: "Sprzedana",
};
const money = (value: number | null) =>
  value === null ? "—" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);

export default async function InvestmentsPage() {
  const properties = (await getProperties()).filter((property) => investmentStatuses.has(property.status));
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inwestycje</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Kupione mieszkania i ich dalsze etapy. Dane są odczytywane z istniejących nieruchomości, bez kopiowania rekordów.
        </p>
      </div>
      {properties.length === 0 ? (
        <div className="ui-card space-y-3 p-6">
          <h2 className="font-semibold">Brak kupionych nieruchomości</h2>
          <p className="text-sm text-muted-foreground">Mieszkania ze statusem Kupiona, Remont, W sprzedaży lub Sprzedana pojawią się tutaj.</p>
          <Link href="/properties" className="text-sm font-semibold text-primary hover:underline">Przejdź do Nieruchomości</Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {properties.map((property) => (
            <article key={property.id} className="ui-card space-y-4 p-5">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">{labels[property.status]}</p>
                <h2 className="mt-1 text-lg font-bold">{property.address || property.title || "Nieruchomość"}</h2>
                <p className="text-sm text-muted-foreground">{[property.district, property.city].filter(Boolean).join(", ")}</p>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-muted-foreground">Cena zakupu</dt><dd className="font-semibold">{money(property.purchasePrice)}</dd></div>
                <div><dt className="text-muted-foreground">Remont — plan</dt><dd className="font-semibold">{money(property.renovationCost)}</dd></div>
                <div><dt className="text-muted-foreground">Prognoza zysku</dt><dd className="font-semibold">{money(property.profit)}</dd></div>
                <div><dt className="text-muted-foreground">ROI</dt><dd className="font-semibold">{property.roi === null ? "—" : `${property.roi.toFixed(1)}%`}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">Faktyczne wydatki i zobowiązania zostaną dodane w kolejnym etapie; wartości remontu są obecnie planem.</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
