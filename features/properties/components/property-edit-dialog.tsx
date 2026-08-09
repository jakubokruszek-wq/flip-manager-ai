"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PropertyWithInvestmentAnalysis } from "@/features/properties/types";

type EditValues = {
  title: string; address: string; city: string; district: string; price: string; area: string; rooms: string; floor: string; totalFloors: string;
  status: string; source: string; description: string; originalUrl: string; images: string; renovationCost: string; expectedSalePrice: string; profit: string; roi: string;
};

type PropertyEditDialogProps = {
  property: PropertyWithInvestmentAnalysis;
  onUpdated: () => void;
};

const statuses = [
  ["draft", "Szkic"], ["analysis", "Analiza"], ["acquired", "Kupiona"], ["renovation", "Remont"], ["listed", "W sprzedaży"], ["sold", "Sprzedana"],
] as const;
const sources = ["otodom", "olx", "morizon", "facebook", "gratka"] as const;

export function PropertyEditDialog({ property, onUpdated }: PropertyEditDialogProps) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<EditValues>(() => toEditValues(property));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setValue = (field: keyof EditValues, value: string) => setValues((current) => ({ ...current, [field]: value }));
  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setValues(toEditValues(property));
      setError(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, images: values.images.split(/\r?\n/).map((url) => url.trim()).filter(Boolean) }),
      });
      const payload: unknown = await readJson(response);
      if (!response.ok) throw new Error(readMessage(payload, "Nie udało się zaktualizować nieruchomości."));
      setOpen(false);
      onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się zaktualizować nieruchomości.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Edytuj</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-1rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Edytuj nieruchomość</DialogTitle><DialogDescription>Zmień dane nieruchomości zapisane w CRM.</DialogDescription></DialogHeader>
        <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Section title="Podstawowe informacje"><div className="grid gap-4 sm:grid-cols-2"><Field className="sm:col-span-2" label="Tytuł"><Input value={values.title} onChange={(event) => setValue("title", event.target.value)} /></Field><Field label="Cena (zł)"><Input inputMode="decimal" value={values.price} onChange={(event) => setValue("price", event.target.value)} /></Field><Field label="Powierzchnia (m²)"><Input inputMode="decimal" value={values.area} onChange={(event) => setValue("area", event.target.value)} /></Field><Field label="Pokoje"><Input inputMode="numeric" value={values.rooms} onChange={(event) => setValue("rooms", event.target.value)} /></Field><Field label="Piętro"><Input placeholder="np. 4, floor_4 lub parter" value={values.floor} onChange={(event) => setValue("floor", event.target.value)} /></Field><Field label="Liczba pięter"><Input inputMode="numeric" value={values.totalFloors} onChange={(event) => setValue("totalFloors", event.target.value)} /></Field><Field label="Status"><select className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm" value={values.status} onChange={(event) => setValue("status", event.target.value)}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Źródło"><select className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm" value={values.source} onChange={(event) => setValue("source", event.target.value)}><option value="">Nie ustawiono</option>{sources.map((source) => <option key={source} value={source}>{source === "olx" ? "OLX" : source[0].toUpperCase() + source.slice(1)}</option>)}</select></Field></div></Section>
          <Section title="Lokalizacja"><div className="grid gap-4 sm:grid-cols-2"><Field className="sm:col-span-2" label="Adres"><Input required value={values.address} onChange={(event) => setValue("address", event.target.value)} /></Field><Field label="Miasto"><Input value={values.city} onChange={(event) => setValue("city", event.target.value)} /></Field><Field label="Dzielnica"><Input value={values.district} onChange={(event) => setValue("district", event.target.value)} /></Field><Field className="sm:col-span-2" label="Link do ogłoszenia"><Input type="url" value={values.originalUrl} onChange={(event) => setValue("originalUrl", event.target.value)} /></Field></div></Section>
          <Section title="Zdjęcia"><p className="text-xs leading-5 text-muted-foreground">Pierwszy adres jest zdjęciem głównym. Wklej jeden adres HTTP(S) w każdej linii.</p><Textarea rows={5} value={values.images} onChange={(event) => setValue("images", event.target.value)} /></Section>
          <Section title="Opis i notatki"><Textarea rows={7} value={values.description} onChange={(event) => setValue("description", event.target.value)} /></Section>
          <Section title="Kalkulator"><div className="grid gap-4 sm:grid-cols-2"><Field label="Koszt remontu (zł)"><Input inputMode="decimal" value={values.renovationCost} onChange={(event) => setValue("renovationCost", event.target.value)} /></Field><Field label="Planowana cena sprzedaży (zł)"><Input inputMode="decimal" value={values.expectedSalePrice} onChange={(event) => setValue("expectedSalePrice", event.target.value)} /></Field><Field label="Zysk (zł)"><Input inputMode="decimal" value={values.profit} onChange={(event) => setValue("profit", event.target.value)} /></Field><Field label="ROI (%)"><Input inputMode="decimal" value={values.roi} onChange={(event) => setValue("roi", event.target.value)} /></Field></div></Section>
          {error ? <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
          <DialogFooter><Button disabled={saving} type="submit">{saving ? "Zapisywanie…" : "Zapisz zmiany"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function toEditValues(property: PropertyWithInvestmentAnalysis): EditValues {
  const number = (value: number | null) => value === null ? "" : String(value);
  return { title: property.title ?? "", address: property.address, city: property.city ?? "", district: property.district ?? "", price: number(property.price), area: number(property.area), rooms: number(property.rooms), floor: property.floor ?? "", totalFloors: property.totalFloors ?? "", status: property.status, source: property.source ?? "", description: property.description ?? "", originalUrl: property.originalUrl ?? "", images: property.images.join("\n"), renovationCost: number(property.renovationCost), expectedSalePrice: number(property.expectedSalePrice), profit: number(property.profit), roi: number(property.roi) };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="space-y-4 border-t border-border/70 pt-5"><h3 className="font-semibold">{title}</h3>{children}</section>; }
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) { return <label className={className}><Label className="mb-2">{label}</Label>{children}</label>; }
async function readJson(response: Response): Promise<unknown> { try { return await response.json(); } catch { return null; } }
function readMessage(value: unknown, fallback: string): string { return value !== null && typeof value === "object" && "message" in value && typeof value.message === "string" ? value.message : fallback; }
