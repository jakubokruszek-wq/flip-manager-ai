"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { importProperty } from "@/features/importer";

export function NewPropertyPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleImport = async () => {
    if (!url) return;

    setLoading(true);

    try {
      const data = await importProperty(url);
      setResult(data);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">
          Dodaj nieruchomość
        </h1>

        <p className="mt-2 text-muted-foreground">
          Wklej link do ogłoszenia.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-6 space-y-6">

        <Input
          placeholder="https://www.otodom.pl/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        <Button
          className="w-full"
          disabled={loading}
          onClick={handleImport}
        >
          {loading ? "Importowanie..." : "Importuj"}
        </Button>

        {result && (
          <div className="rounded-xl border p-4 space-y-2">
            <div>
              <b>Źródło:</b> {result.source}
            </div>

            <div className="break-all">
              <b>Link:</b> {result.url}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}