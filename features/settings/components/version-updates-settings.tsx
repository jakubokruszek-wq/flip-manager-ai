"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

const RUNNING_COMMIT_SHA = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "local";

function shortSha(value: string | null | undefined) {
  return value?.trim() ? value.trim().slice(0, 7) : null;
}

function waitForWorkerState(worker: ServiceWorker, timeoutMs: number) {
  if (worker.state === "activated" || worker.state === "redundant") return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(finish, timeoutMs);
    function finish() {
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    }
    function onStateChange() {
      if (worker.state === "activated" || worker.state === "redundant") finish();
    }
    worker.addEventListener("statechange", onStateChange);
  });
}

export function VersionUpdatesSettings() {
  const [productionSha, setProductionSha] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hasEditedSinceLoad = useRef(false);
  const allowUpdateNavigation = useRef(false);
  const runningSha = shortSha(RUNNING_COMMIT_SHA === "local" ? null : RUNNING_COMMIT_SHA);
  const latestSha = shortSha(productionSha);
  const updateAvailable = Boolean(productionSha && RUNNING_COMMIT_SHA !== "local" && productionSha !== RUNNING_COMMIT_SHA);

  useEffect(() => {
    const markEdited = () => { hasEditedSinceLoad.current = true; };
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasEditedSinceLoad.current || allowUpdateNavigation.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("input", markEdited, true);
    document.addEventListener("change", markEdited, true);
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      document.removeEventListener("input", markEdited, true);
      document.removeEventListener("change", markEdited, true);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/build-info", { cache: "no-store" });
      const body = (await response.json()) as { commitSha?: unknown };
      if (!response.ok || typeof body.commitSha !== "string" || !body.commitSha.trim()) {
        throw new Error("Nie udało się odczytać wersji Production.");
      }
      setProductionSha(body.commitSha.trim());
      setMessage(RUNNING_COMMIT_SHA === "local"
        ? "Nie można porównać wersji lokalnej z wersją uruchomioną w przeglądarce."
        : body.commitSha.trim() === RUNNING_COMMIT_SHA
          ? "Aplikacja jest aktualna."
          : "Dostępna aktualizacja.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Nie udało się sprawdzić aktualizacji.");
    } finally {
      setChecking(false);
    }
  }

  async function applyUpdate() {
    if (!productionSha || !updateAvailable) return;
    if (hasEditedSinceLoad.current && !window.confirm("Masz zmiany wprowadzone na tej stronie. Przeładowanie może je utracić. Czy chcesz kontynuować aktualizację?")) return;

    setUpdating(true);
    setMessage("Przygotowuję bezpieczne odświeżenie aplikacji…");
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration("/");
        if (registration) {
          await registration.update();
          const installingWorker = registration.installing;
          if (installingWorker) await waitForWorkerState(installingWorker, 10_000);
          if (registration.waiting) {
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
            await waitForWorkerState(registration.waiting, 10_000);
          }
        }
      }

      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("_app_update", shortSha(productionSha) ?? "latest");
      allowUpdateNavigation.current = true;
      window.location.replace(nextUrl.toString());
    } catch {
      setUpdating(false);
      setMessage("Nie udało się bezpiecznie odświeżyć aplikacji. Twoje dane i formularze pozostały bez zmian — spróbuj ponownie.");
    }
  }

  return (
    <section className="ui-section" data-testid="version-updates-settings">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="type-section-title">Wersja i aktualizacje</h2>
          <p className="mt-1 text-sm text-muted-foreground">Wersja aplikacji i dostępność aktualizacji Production.</p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">PWA i przeglądarka</span>
      </div>

      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">Uruchomiona wersja</dt>
          <dd className="mt-1 font-medium" data-testid="running-app-version">{runningSha ?? "Nieznana"}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Aktualna wersja Production</dt>
          <dd className="mt-1 font-medium" data-testid="production-app-version">{latestSha ?? "Nie sprawdzono"}</dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap gap-3">
        <Button type="button" className="min-h-11" onClick={() => void checkForUpdates()} disabled={checking || updating}>
          {checking ? "Sprawdzanie…" : "Sprawdź aktualizacje"}
        </Button>
        {updateAvailable ? (
          <Button type="button" className="min-h-11" onClick={() => void applyUpdate()} disabled={updating}>
            {updating ? "Aktualizowanie…" : "Aktualizuj"}
          </Button>
        ) : null}
      </div>

      {updateAvailable ? <p className="mt-3 text-sm font-medium text-amber-500" role="status">Dostępna aktualizacja: {latestSha}</p> : null}
      {message ? <p className="mt-3 text-sm text-muted-foreground" role="status">{message}</p> : null}
      <p className="mt-3 text-xs text-muted-foreground">Aktualizacja odświeża aplikację bez czyszczenia zapisanych danych. Jeśli edytujesz formularz, poprosimy o potwierdzenie przed przeładowaniem.</p>
    </section>
  );
}
