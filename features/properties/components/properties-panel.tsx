"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { AddPropertyButton } from "@/features/properties/components/add-property-button";
import { PropertiesEmptyState } from "@/features/properties/components/properties-empty-state";
import { PropertiesTable } from "@/features/properties/components/properties-table";
import { FEATURE_TITLE } from "@/features/properties/constants";
import type { PropertyWithInvestmentAnalysis } from "@/features/properties/types";

type PropertiesPanelProps = {
  properties: PropertyWithInvestmentAnalysis[];
};

export function PropertiesPanel({ properties }: PropertiesPanelProps) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const hasProperties = properties.length > 0;
  const onDeleted = () => {
    setNotice("Nieruchomość została usunięta.");
    router.push("/properties");
    router.refresh();
  };
  const onUpdated = () => {
    setNotice("Nieruchomość została zaktualizowana.");
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={FEATURE_TITLE}
        actions={
          <AddPropertyButton
            label="Dodaj nieruchomość"
            showPlus
          />
        }
      />

      {notice ? <p aria-live="polite" className="rounded-xl border border-success/25 bg-success/10 px-4 py-3 text-sm text-success">{notice}</p> : null}

      {hasProperties ? (
        <PropertiesTable properties={properties} onDeleted={onDeleted} onUpdated={onUpdated} />
      ) : (
        <PropertiesEmptyState />
      )}
    </div>
  );
}
