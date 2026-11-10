"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PropertyForm } from "@/features/properties/components/property-form";
import type { PropertyFormValues } from "@/features/properties/types/property";
const initial: PropertyFormValues = { title: "", address: "", city: "Łódź", district: "", price: "", area: "", rooms: "", floor: "", buildingType: "", ownership: "", rent: "", description: "", originalUrl: "", source: "" };
export function ManualProperty() {
  const router = useRouter(); const [values, setValues] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/properties", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, images: [] }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || "Nie udało się dodać mieszkania.");
      router.push(`/properties/${body.id}`); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Nie udało się zapisać."); setBusy(false); }
  }
  return <div className="mx-auto max-w-3xl space-y-5"><h1 className="text-3xl font-bold">Dodaj mieszkanie ręcznie</h1><p className="text-sm leading-6 text-muted-foreground">Wymagany jest adres. Źródło i link możesz zostawić puste. Własne zdjęcia i dokumenty dodasz po zapisaniu, w karcie mieszkania.</p>{error ? <p role="alert" className="rounded-xl border border-red-500 p-4">{error}</p> : null}<PropertyForm values={values} saving={busy} onChange={(field, value) => setValues(previous => ({ ...previous, [field]: value }))} onSubmit={save} /></div>;
}
