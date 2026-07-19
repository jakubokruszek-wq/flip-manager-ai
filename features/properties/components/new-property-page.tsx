"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PropertyForm } from "@/features/properties/components/property-form";
import { PropertyGallery } from "@/features/properties/components/property-gallery";
import { PropertySummary } from "@/features/properties/components/property-summary";
import type { ImportedProperty } from "@/features/importer";
import type {
  ImportedPropertyFormField,
  ImportedPropertyFormValues,
  PropertySaveRequest,
  SavePropertyResponse,
} from "@/features/properties/types/imported-property-form";

export function NewPropertyPage() {
  const [url, setUrl] = useState("");
  const [importedProperty, setImportedProperty] = useState<ImportedProperty | null>(null);
  const [formValues, setFormValues] = useState<ImportedPropertyFormValues | null>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<SavePropertyResponse | null>(null);

  const handleImport = async () => {
    if (!url) return;

    setImporting(true);
    setImportError(null);
    setSaveError(null);
    setSaveSuccess(null);
    setImportedProperty(null);
    setFormValues(null);

    try {
      const response = await fetch("/api/import", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      const data: unknown = await response.json();

      if (!response.ok) {
        throw new Error(getErrorMessage(data));
      }

      const property = data as ImportedProperty;
      console.log("IMPORT RESULT:", property);
      setImportedProperty(property);
      setFormValues(toFormValues(property));
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Nie udało się zaimportować ogłoszenia."
      );
    } finally {
      setImporting(false);
    }
  };

  const handleFieldChange = (field: ImportedPropertyFormField, value: string) => {
    setFormValues((current) => (current ? { ...current, [field]: value } : current));
    setSaveSuccess(null);
  };

  const handleSave = async () => {
    if (!formValues || saving) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const response = await fetch("/api/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formValues,
          images: importedProperty?.images ?? [],
        } satisfies PropertySaveRequest),
      });
      const data: unknown = await response.json();

      if (!response.ok) {
        throw new Error(getErrorMessage(data));
      }

      setSaveSuccess(data as SavePropertyResponse);
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Nie udało się zapisać nieruchomości."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Dodaj nieruchomość</h1>
        <p className="mt-2 text-muted-foreground">Wklej link do ogłoszenia.</p>
      </div>

      <div className="space-y-6 rounded-xl border bg-card p-6">
        <Input
          placeholder="https://www.otodom.pl/..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button className="w-full" disabled={importing} onClick={handleImport}>
          {importing ? "Importowanie..." : "Importuj"}
        </Button>

        {importError && <p className="text-sm text-destructive">{importError}</p>}
      </div>

      {importedProperty && formValues && (
        <article className="space-y-8 rounded-xl border bg-card p-5 sm:p-6">
          <PropertyGallery images={importedProperty.images} title={formValues.title} />
          <PropertySummary values={formValues} />
          <PropertyForm
            values={formValues}
            saving={saving}
            onChange={handleFieldChange}
            onSubmit={handleSave}
          />

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {saveSuccess && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-50">
              <p className="font-semibold">Nieruchomość została zapisana.</p>
              <p className="mt-1">Zapisane kolumny: {saveSuccess.savedColumns.join(", ")}.</p>
            </div>
          )}
        </article>
      )}
    </div>
  );
}

function toFormValues(property: ImportedProperty): ImportedPropertyFormValues {
  return {
    title: property.title,
    price: property.price?.toString() ?? "",
    area: property.area?.toString() ?? "",
    rooms: property.rooms?.toString() ?? "",
    floor: property.floor ?? "",
    buildingType: property.buildingType ?? "",
    ownership: property.ownership ?? "",
    rent: property.rent?.toString() ?? "",
    address: property.address ?? "",
    district: property.district ?? "",
    city: property.city ?? "",
    description: property.description ?? "",
    originalUrl: property.originalUrl,
    source: property.source,
  };
}

function getErrorMessage(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }

  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }

  return "Nie udało się wykonać operacji.";
}
