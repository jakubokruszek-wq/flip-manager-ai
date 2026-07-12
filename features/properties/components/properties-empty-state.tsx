import { Building2 } from "lucide-react";

import { AddPropertyButton } from "@/features/properties/components/add-property-button";

export function PropertiesEmptyState() {
  return (
    <div className="rounded-2xl border border-border bg-surface-elevated px-6 py-16 sm:px-12">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-muted text-muted-foreground">
          <Building2 className="h-6 w-6" aria-hidden="true" />
        </div>

        <h2 className="mt-6 text-base font-medium text-foreground">
          Nie masz jeszcze żadnych nieruchomości
        </h2>

        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Dodaj pierwszą nieruchomość, aby śledzić koszty, prognozy sprzedaży
          i rentowność flipów w jednym miejscu.
        </p>

        <div className="mt-8">
          <AddPropertyButton
            label="Dodaj pierwszą nieruchomość"
            showPlus={false}
          />
        </div>
      </div>
    </div>
  );
}
