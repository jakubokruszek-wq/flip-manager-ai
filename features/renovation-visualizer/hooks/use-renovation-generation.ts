"use client";

import { useCallback, useEffect, useState } from "react";
import type { RenovationVisualizationInput, RenovationVisualizationOutput, RenovationVisualizerApiResponse } from "../types";

export function useRenovationGeneration() {
  const [result, setResult] = useState<RenovationVisualizationOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setProgress((value) => Math.min(92, value + Math.max(1, Math.round((94 - value) / 9)))), 650);
    return () => window.clearInterval(timer);
  }, [loading]);

  const generate = useCallback(async (input: RenovationVisualizationInput) => {
    setLoading(true); setProgress(6); setError(null);
    try {
      const response = await fetch("/api/renovation-visualizer/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const payload: unknown = await response.json();
      if (!isApiResponse(payload)) throw new Error("Nieprawidłowa odpowiedź generatora.");
      if (!payload.ok) throw new Error(payload.message);
      setProgress(100); setResult(payload.result);
      return payload.result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się wygenerować wizualizacji.");
      return null;
    } finally { setLoading(false); }
  }, []);

  const clearResult = useCallback(() => { setResult(null); setError(null); setProgress(0); }, []);
  return { result, loading, progress, error, generate, clearResult };
}

function isApiResponse(value: unknown): value is RenovationVisualizerApiResponse { return Boolean(value && typeof value === "object" && "ok" in value && typeof (value as { ok?: unknown }).ok === "boolean"); }
