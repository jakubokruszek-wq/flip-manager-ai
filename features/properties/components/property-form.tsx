"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  ImportedPropertyFormField,
  ImportedPropertyFormValues,
} from "@/features/properties/types/imported-property-form";

type PropertyFormProps = {
  values: ImportedPropertyFormValues;
  saving: boolean;
  onChange: (field: ImportedPropertyFormField, value: string) => void;
  onSubmit: () => void;
};

export function PropertyForm({ values, saving, onChange, onSubmit }: PropertyFormProps) {
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const hasLongDescription = values.description.length > 600;

  return (
    <form
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <section aria-labelledby="basic-information" className="space-y-4 border-t pt-6">
        <h2 id="basic-information" className="text-lg font-semibold">
          Informacje podstawowe
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Tytuł" htmlFor="title" className="sm:col-span-2">
            <Input id="title" value={values.title} onChange={(event) => onChange("title", event.target.value)} />
          </FormField>
          <FormField label="Cena (zł)" htmlFor="price">
            <Input id="price" type="number" min="0" value={values.price} onChange={(event) => onChange("price", event.target.value)} />
          </FormField>
          <FormField label="Powierzchnia (m²)" htmlFor="area">
            <Input id="area" type="number" min="0" step="0.01" value={values.area} onChange={(event) => onChange("area", event.target.value)} />
          </FormField>
          <FormField label="Pokoje" htmlFor="rooms">
            <Input id="rooms" type="number" min="0" step="1" value={values.rooms} onChange={(event) => onChange("rooms", event.target.value)} />
          </FormField>
          <FormField label="Piętro" htmlFor="floor">
            <Input id="floor" value={values.floor} onChange={(event) => onChange("floor", event.target.value)} />
          </FormField>
          <FormField label="Typ budynku" htmlFor="building-type">
            <Input id="building-type" value={values.buildingType} onChange={(event) => onChange("buildingType", event.target.value)} />
          </FormField>
          <FormField label="Własność" htmlFor="ownership">
            <Input id="ownership" value={values.ownership} onChange={(event) => onChange("ownership", event.target.value)} />
          </FormField>
          <FormField label="Czynsz (zł)" htmlFor="rent">
            <Input id="rent" type="number" min="0" value={values.rent} onChange={(event) => onChange("rent", event.target.value)} />
          </FormField>
          <FormField label="Źródło" htmlFor="source">
            <Input id="source" value={values.source} onChange={(event) => onChange("source", event.target.value)} />
          </FormField>
        </div>
      </section>

      <section aria-labelledby="location" className="space-y-4 border-t pt-6">
        <h2 id="location" className="text-lg font-semibold">
          Lokalizacja
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Adres" htmlFor="address" className="sm:col-span-2">
            <Input id="address" value={values.address} onChange={(event) => onChange("address", event.target.value)} />
          </FormField>
          <FormField label="Dzielnica" htmlFor="district">
            <Input id="district" value={values.district} onChange={(event) => onChange("district", event.target.value)} />
          </FormField>
          <FormField label="Miasto" htmlFor="city">
            <Input id="city" value={values.city} onChange={(event) => onChange("city", event.target.value)} />
          </FormField>
          <FormField label="Link do ogłoszenia" htmlFor="original-url" className="sm:col-span-2">
            <Input id="original-url" type="url" value={values.originalUrl} onChange={(event) => onChange("originalUrl", event.target.value)} />
          </FormField>
        </div>
      </section>

      <section aria-labelledby="description" className="space-y-4 border-t pt-6">
        <h2 id="description" className="text-lg font-semibold">
          Opis
        </h2>
        <Textarea
          id="description-input"
          rows={descriptionExpanded ? 14 : 6}
          value={values.description}
          onChange={(event) => onChange("description", event.target.value)}
        />
        {hasLongDescription && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-0"
            onClick={() => setDescriptionExpanded((expanded) => !expanded)}
          >
            {descriptionExpanded ? "Pokaż mniej" : "Pokaż więcej"}
          </Button>
        )}
      </section>

      <Button type="submit" className="w-full sm:w-auto" disabled={saving}>
        {saving ? "Zapisywanie..." : "Zapisz nieruchomość"}
      </Button>
    </form>
  );
}

function FormField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} className="mb-2">
        {label}
      </Label>
      {children}
    </div>
  );
}
