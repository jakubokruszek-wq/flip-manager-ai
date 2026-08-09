"use client";

import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PropertyForm } from "@/features/properties/components/property-form";
import { PropertyGallery } from "@/features/properties/components/property-gallery";
import { PropertySummary } from "@/features/properties/components/property-summary";
import type { ImportedProperty } from "@/features/importer";
import type { ImportedPropertyFormField, ImportedPropertyFormValues, PropertySaveRequest, SavePropertyResponse } from "@/features/properties/types/imported-property-form";

type FacebookMeta = { neighborhood: string | null; totalFloors: number | null; marketType: "primary" | "secondary" | null; condition: "renovation" | "ready" | null; sellerType: "private" | "agency" | null; publishedAt: string | null; confidence: number; flags: string[] };
type ImportResponse = ImportedProperty & { facebookMeta?: FacebookMeta };
type FacebookWatcherImport = { listingId: string; opportunityScore: number; extracted: { images: string[] } };

export function NewPropertyPage() {
  const [url, setUrl] = useState("");
  const [manualFacebook, setManualFacebook] = useState(false);
  const [postText, setPostText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageUrls, setImageUrls] = useState("");
  const [uploading, setUploading] = useState(false);
  const [facebookMeta, setFacebookMeta] = useState<FacebookMeta | null>(null);
  const [finderImport, setFinderImport] = useState<FacebookWatcherImport | null>(null);
  const [importedProperty, setImportedProperty] = useState<ImportedProperty | null>(null);
  const [formValues, setFormValues] = useState<ImportedPropertyFormValues | null>(null);
  const [importing, setImporting] = useState(false); const [saving, setSaving] = useState(false); const [finderSaving, setFinderSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null); const [saveError, setSaveError] = useState<string | null>(null); const [saveSuccess, setSaveSuccess] = useState<SavePropertyResponse | null>(null); const [finderResult, setFinderResult] = useState<string | null>(null);

  const handleImport = async () => {
    if (!url) return; setImporting(true); setImportError(null); setSaveError(null); setSaveSuccess(null); setFinderResult(null); setFinderImport(null); setImportedProperty(null); setFormValues(null);
    try {
      const mergedImages = [...new Set([...images, ...imageUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)])];
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, postText: manualFacebook ? postText : undefined, images: mergedImages }) });
      const data: unknown = await response.json();
      if (isRecord(data) && data.code === "FACEBOOK_CONTENT_REQUIRED") { setUrl(typeof data.normalizedUrl === "string" ? data.normalizedUrl : url); setPostText(""); setManualFacebook(true); setImportError(null); return; }
      if (!response.ok) throw new Error(getErrorMessage(data));
      const property = data as ImportResponse; setImportedProperty(property); setImages(property.images); setFacebookMeta(property.facebookMeta ?? null); setFormValues(toFormValues(property));
    } catch (error) { setImportError(error instanceof Error ? error.message : "Nie udało się zaimportować ogłoszenia."); } finally { setImporting(false); }
  };

  async function uploadFiles(files: File[]) {
    if (!files.length) return; setUploading(true); setImportError(null);
    try { const form = new FormData(); files.forEach((file) => form.append("images", file)); const response = await fetch("/api/facebook-watcher/images", { method: "POST", body: form }); const data = await response.json(); if (!response.ok) throw new Error(getErrorMessage(data)); setImages((current) => [...new Set([...current, ...(data.urls as string[])])]); }
    catch (error) { setImportError(error instanceof Error ? error.message : "Nie udało się przesłać zdjęć."); } finally { setUploading(false); }
  }

  const handleFieldChange = (field: ImportedPropertyFormField, value: string) => { setFormValues((current) => current ? { ...current, [field]: value } : current); setFinderImport(null); setSaveSuccess(null); };
  const importIntoFacebookWatcher = async (): Promise<FacebookWatcherImport> => {
    if (!formValues) throw new Error("Brak danych oferty do zapisania.");
    const response = await fetch("/api/facebook-watcher/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, postText, images, analysisConfidence: facebookMeta?.confidence, analysisFlags: facebookMeta?.flags, overrides: { title: formValues.title, city: formValues.city || null, district: formValues.district || null, neighborhood: facebookMeta?.neighborhood ?? null, street: formValues.address || null, price: nullableNumber(formValues.price), area: nullableNumber(formValues.area), rooms: nullableNumber(formValues.rooms), floor: nullableNumber(formValues.floor), marketType: facebookMeta?.marketType ?? null, condition: facebookMeta?.condition ?? null, sellerType: facebookMeta?.sellerType ?? null, description: formValues.description || null } }),
    });
    const data: unknown = await response.json();
    if (!response.ok || !isFacebookWatcherImport(data)) throw new Error(getErrorMessage(data));
    setFinderImport(data);
    setImages(data.extracted.images);
    return data;
  };
  const handleSave = async () => {
    if (!formValues || saving) return; setSaving(true); setSaveError(null); setSaveSuccess(null);
    try {
      if (facebookMeta) {
        const imported = finderImport ?? await importIntoFacebookWatcher();
        const response = await fetch("/api/properties/import-from-finder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: imported.listingId, title: formValues.title, price: nullableNumber(formValues.price), area: nullableNumber(formValues.area), rooms: nullableNumber(formValues.rooms), floor: formValues.floor || null, buildingType: formValues.buildingType || null, ownership: formValues.ownership || null, description: formValues.description || null, images: imported.extracted.images, locationText: formValues.address || null, address: formValues.address || null, city: formValues.city || null, district: formValues.district || null, originalUrl: formValues.originalUrl, normalizedUrl: formValues.originalUrl, source: "facebook", externalListingId: null, investmentAnalysis: null }) });
        const data: unknown = await response.json();
        if (!response.ok || !isRecord(data) || typeof data.propertyId !== "string") throw new Error(getErrorMessage(data));
        setSaveSuccess({ id: data.propertyId, savedColumns: ["listing_id", "images", "source", "original_url"] });
      } else {
        const response = await fetch("/api/properties", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...formValues, images } satisfies PropertySaveRequest) });
        const data: unknown = await response.json();
        if (!response.ok) throw new Error(getErrorMessage(data));
        setSaveSuccess(data as SavePropertyResponse);
      }
    }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Nie udało się zapisać nieruchomości."); } finally { setSaving(false); }
  };
  const handleFinderSave = async () => {
    if (!formValues || finderSaving) return; setFinderSaving(true); setSaveError(null);
    try { const data = finderImport ?? await importIntoFacebookWatcher(); setFinderResult(`Oferta dodana do Flip Findera. ID: ${data.listingId}, Flip Score: ${data.opportunityScore}.`); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Nie udało się dodać oferty do Flip Findera."); } finally { setFinderSaving(false); }
  };
  const cancelFacebook = () => { setManualFacebook(false); setPostText(""); setImages([]); setImageUrls(""); setImportedProperty(null); setFormValues(null); setFacebookMeta(null); setFinderImport(null); setImportError(null); };

  return <div className="mx-auto max-w-4xl space-y-8">
    <div><h1 className="text-3xl font-bold">Dodaj nieruchomość</h1><p className="mt-2 text-muted-foreground">Wklej link do ogłoszenia.</p></div>
    <div className="space-y-5 rounded-xl border bg-card p-6">
      <Input aria-label="Link do ogłoszenia" placeholder="https://www.otodom.pl/... lub https://www.facebook.com/..." value={url} onChange={(event) => setUrl(event.target.value)} />
      {manualFacebook && <section className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4" onPaste={(event) => { const files = [...event.clipboardData.items].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)); if (files.length) { event.preventDefault(); void uploadFiles(files); } }}>
        <div><h2 className="font-semibold">Facebook ogranicza automatyczne pobieranie tego posta.</h2><p className="mt-1 text-sm text-muted-foreground">Otwórz post na Facebooku → skopiuj tekst ogłoszenia → wklej go tutaj. Możesz również wkleić lub przeciągnąć zdjęcia.</p></div>
        <Textarea aria-label="Treść ogłoszenia Facebook" name="facebook-post-text" autoComplete="off" rows={7} value={postText} onChange={(event) => setPostText(event.target.value)} placeholder="Wklej tutaj treść posta z Facebooka…" />
        <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed p-4 text-center outline-none focus-within:ring-2 focus-within:ring-primary" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadFiles([...event.dataTransfer.files]); }}><ImagePlus className="mb-2 size-5"/><span className="text-sm font-medium">Dodaj, przeciągnij lub wklej zdjęcia</span><span className="text-xs text-muted-foreground">JPG, PNG lub WebP, maks. 8 MB</span><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void uploadFiles([...event.target.files ?? []])}/></label>
        <Textarea aria-label="Adresy zdjęć" rows={2} value={imageUrls} onChange={(event) => setImageUrls(event.target.value)} placeholder="Lub wklej URL zdjęć — jeden w wierszu" />
        {images.length > 0 && <p className="text-sm text-muted-foreground">Dodane zdjęcia: {images.length}</p>}
      </section>}
      <Button className="w-full" disabled={importing || uploading || (manualFacebook && !postText.trim() && images.length === 0 && !imageUrls.trim())} onClick={handleImport}>{importing ? "Analizowanie..." : manualFacebook ? "Analizuj ogłoszenie" : "Importuj"}</Button>
      {manualFacebook && <Button className="w-full" variant="ghost" onClick={cancelFacebook}>Anuluj</Button>}{importError && <p className="text-sm text-destructive">{importError}</p>}
    </div>
    {importedProperty && formValues && <article className="space-y-8 rounded-xl border bg-card p-5 sm:p-6">
      {facebookMeta && <section className="rounded-xl border border-primary/30 bg-primary/5 p-4"><h2 className="font-semibold">Rozpoznane dane</h2><div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><p>Lokalizacja: {[facebookMeta.neighborhood, formValues.city].filter(Boolean).join(", ") || "brak"}</p><p>Cena/m²: {pricePerSqm(formValues)}</p><p>Stan: {facebookMeta.condition === "renovation" ? "do remontu" : facebookMeta.condition === "ready" ? "do wejścia" : "brak danych"}</p><p>Sprzedający: {facebookMeta.sellerType === "private" ? "prywatny" : facebookMeta.sellerType === "agency" ? "pośrednik" : "brak danych"}</p><p>Źródło: Facebook</p><p>Confidence: {Math.round(facebookMeta.confidence * 100)}%</p></div></section>}
      <PropertyGallery images={images} title={formValues.title}/><PropertySummary values={formValues}/>
      {facebookMeta && <Button className="w-full" variant="secondary" disabled={finderSaving} onClick={handleFinderSave}>{finderSaving ? "Dodawanie..." : "Dodaj do Flip Findera"}</Button>}
      <PropertyForm values={formValues} saving={saving} onChange={handleFieldChange} onSubmit={handleSave} submitLabel={facebookMeta ? "Dodaj bezpośrednio do CRM" : undefined}/>
      {saveError && <p className="text-sm text-destructive">{saveError}</p>}{finderResult && <p className="text-sm text-emerald-600">{finderResult}</p>}{saveSuccess && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-50"><p className="font-semibold">Nieruchomość została zapisana.</p><p className="mt-1">Zapisane kolumny: {saveSuccess.savedColumns.join(", ")}.</p></div>}
    </article>}
  </div>;
}

function toFormValues(property: ImportedProperty): ImportedPropertyFormValues { return { title: property.title, price: property.price?.toString() ?? "", area: property.area?.toString() ?? "", rooms: property.rooms?.toString() ?? "", floor: property.floor ?? "", buildingType: property.buildingType ?? "", ownership: property.ownership ?? "", rent: property.rent?.toString() ?? "", address: property.address ?? "", district: property.district ?? "", city: property.city ?? "", description: property.description ?? "", originalUrl: property.originalUrl, source: property.source }; }
function getErrorMessage(value: unknown): string { return isRecord(value) && typeof (value.message ?? value.error) === "string" ? String(value.message ?? value.error) : "Nie udało się wykonać operacji."; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isFacebookWatcherImport(value: unknown): value is FacebookWatcherImport { return isRecord(value) && typeof value.listingId === "string" && typeof value.opportunityScore === "number" && isRecord(value.extracted) && Array.isArray(value.extracted.images) && value.extracted.images.every((image) => typeof image === "string"); }
function nullableNumber(value: string): number | null { const parsed = Number(value.replace(",", ".")); return value.trim() && Number.isFinite(parsed) ? parsed : null; }
function pricePerSqm(values: ImportedPropertyFormValues): string { const price = nullableNumber(values.price); const area = nullableNumber(values.area); return price && area ? `${Math.round(price / area).toLocaleString("pl-PL")} zł` : "brak danych"; }
