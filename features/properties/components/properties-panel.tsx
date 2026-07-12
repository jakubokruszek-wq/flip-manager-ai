import { PageHeader } from "@/components/ui/page-header";
import { AddPropertyButton } from "@/features/properties/components/add-property-button";
import { PropertiesEmptyState } from "@/features/properties/components/properties-empty-state";
import { PropertiesTable } from "@/features/properties/components/properties-table";
import { FEATURE_TITLE } from "@/features/properties/constants";
import type { Property } from "@/features/properties/types";

type PropertiesPanelProps = {
  properties: Property[];
};

export function PropertiesPanel({ properties }: PropertiesPanelProps) {
  const hasProperties = properties.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={FEATURE_TITLE}
        actions={
          <AddPropertyButton label="Dodaj nieruchomość" showPlus />
        }
      />

      {hasProperties ? (
        <PropertiesTable properties={properties} />
      ) : (
        <PropertiesEmptyState />
      )}
    </div>
  );
}
