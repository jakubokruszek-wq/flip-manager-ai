"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/ui/metric-card";
import { DEFAULT_RADAR_DISTRICTS, MIN_RADAR_SAMPLE_SIZE, type RadarDistrictQueueItem, type RadarListing, type RadarMarketFilter, type RadarQualificationRejections, type RadarSource, type RadarStatGroup, type RadarRunStatus, type RadarQualityCategory, type RadarProgressDiagnostics, type RadarVerificationDecision, type RadarVerificationQueueItem } from "@/features/price-radar/types";
import { isRadarDailyScanDue, nextRadarDailyScanAt } from "@/features/price-radar/server/radar-scheduler";
import { radarRunActivity } from "@/features/price-radar/run-presentation";
import { describeRadarRequestError, RadarHttpError, radarConnectionIssue, radarLeaseExpiredForBrowserResume, radarRunPollDelayMs } from "@/features/price-radar/run-connection";

type ResultsResponse = {
  listings: RadarListing[];
  excludedListings: RadarListing[];
  stats: RadarStatGroup[];
  activeSources: RadarSource[];
  disabledSourceNote: string;
};
type DistrictQueueResponse = { available: boolean; pending: RadarDistrictQueueItem[]; assigned: RadarDistrictQueueItem[]; rejected: RadarDistrictQueueItem[] };
type VerificationQueueResponse = { available: boolean; pending: RadarVerificationQueueItem[]; confirmed: RadarVerificationQueueItem[]; rejected: RadarVerificationQueueItem[] };
type RunStatus = { id: string; status: RadarRunStatus; startedAt: string; finishedAt: string | null; leaseUntil: string | null; stopRequestedAt: string | null; userTerminatedAt: string | null; lastProgressAt?: string | null; olxJobStatus?: "queued" | "running" | "completed" | "failed" | "missing" | "unavailable"; olxJobLeaseUntil?: string | null; scannedCount: number; qualifiedCount: number; sourceStatuses: Record<string, string>; sourceErrors: Record<string, string>; sourceWarnings?: Record<string, string[]>; sourceRejectionCounts?: Record<string, Record<string, number>>; qualificationRejections?: RadarQualificationRejections; errorMessage: string | null; checkpoint?: { sourceQueue?: string[]; currentSourceIndex?: number; rejectedCount?: number; verificationQueuedCount?: number; districtQueuedCount?: number; lastProgressAt?: string; progress?: RadarProgressDiagnostics } };
type SettingsResponse = { filters: { districts: string[]; market: RadarMarketFilter; areaMin: number | null; areaMax: number | null; rooms: number[]; sources: RadarSource[]; minPricePerSqm: number | null; automaticScanEnabled: boolean; automaticScanTime: string }; activeSources: RadarSource[]; disabledSourceNote: string };

const ROOM_OPTIONS = [1, 2, 3, 4, 5];
const SOURCE_OPTIONS: { value: RadarSource; label: string }[] = [
  { value: "otodom", label: "Otodom" },
  { value: "olx", label: "OLX" },
  { value: "morizon", label: "Morizon" },
  { value: "domiporta", label: "Domiporta" },
  { value: "sprzedajemy", label: "Sprzedajemy.pl" },
  { value: "adresowo", label: "Adresowo.pl" },
  { value: "gratka", label: "Gratka" },
  { value: "nieruchomosci_online", label: "Nieruchomosci-online.pl" },
  { value: "oferty_net", label: "Oferty.net" },
  { value: "domy", label: "Domy.pl" },
  { value: "allegro_lokalnie", label: "Allegro Lokalnie" },
  { value: "official_cooperative", label: "Spółdzielnie Łódź" },
  { value: "official_uml", label: "UMŁ/BIP Łódź" },
];

export function PriceRadarPage() {
  const [districts, setDistricts] = useState<string[]>([...DEFAULT_RADAR_DISTRICTS]);
  const [market, setMarket] = useState<RadarMarketFilter>("both");
  const [areaMin, setAreaMin] = useState("");
  const [areaMax, setAreaMax] = useState("");
  const [minPricePerSqm, setMinPricePerSqm] = useState("");
  const [automaticScanEnabled, setAutomaticScanEnabled] = useState(true);
  const [automaticScanTime, setAutomaticScanTime] = useState("05:00");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [rooms, setRooms] = useState<number[]>([]);
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingExclusion, setPendingExclusion] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [activeSourceIds, setActiveSourceIds] = useState<RadarSource[]>([]);
  const [disabledSourceNote, setDisabledSourceNote] = useState("");
  const [run, setRun] = useState<RunStatus | null>(null);
  const runActivity = useMemo(() => radarRunActivity(run, clockNow), [run, clockNow]);
  const [runStarting, setRunStarting] = useState(false);
  const [runStopping, setRunStopping] = useState(false);
  const [runTerminating, setRunTerminating] = useState(false);
  const [autoResumeMessage, setAutoResumeMessage] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const autoResumeInFlight = useRef(false);
  const stopFinalizeInFlight = useRef(false);
  const lastAutoResumeAttempt = useRef<{ key: string; at: number } | null>(null);
  const refreshRunNow = useRef<(() => void) | null>(null);
  const [districtQueue, setDistrictQueue] = useState<DistrictQueueResponse | null>(null);
  const [districtChoices, setDistrictChoices] = useState<Record<string, string>>({});
  const [districtQueuePending, setDistrictQueuePending] = useState<string | null>(null);
  const [districtQueueError, setDistrictQueueError] = useState<string | null>(null);
  const [verificationQueue, setVerificationQueue] = useState<VerificationQueueResponse | null>(null);
  const [verificationQueueError, setVerificationQueueError] = useState<string | null>(null);
  const [verificationPending, setVerificationPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/price-radar/settings").then(async (response) => {
      const payload = await response.json() as SettingsResponse | { message?: string };
      if (!response.ok || !("filters" in payload)) throw new Error("message" in payload && payload.message ? payload.message : "Nie udało się odczytać zapisanych filtrów Radaru.");
      if (cancelled) return;
      setDistricts(payload.filters.districts);
      setMarket(payload.filters.market);
      setAreaMin(payload.filters.areaMin === null ? "" : String(payload.filters.areaMin));
      setAreaMax(payload.filters.areaMax === null ? "" : String(payload.filters.areaMax));
      setMinPricePerSqm(payload.filters.minPricePerSqm === null ? "" : String(payload.filters.minPricePerSqm));
      setAutomaticScanEnabled(payload.filters.automaticScanEnabled);
      setAutomaticScanTime(payload.filters.automaticScanTime);
      setRooms(payload.filters.rooms);
      setSources(payload.filters.sources);
      setActiveSourceIds(payload.activeSources);
      setDisabledSourceNote(payload.disabledSourceNote);
      setSettingsLoaded(true);
    }).catch((reason) => {
      if (!cancelled) { setError(describeRadarRequestError(reason, "Nie udało się odczytać filtrów Radaru.")); setSettingsLoaded(true); }
    });
    return () => { cancelled = true; };
  }, []);

  const saveSettings = useCallback(async () => {
    setSettingsSaving(true);
    try {
      const response = await apiFetch("/api/price-radar/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { districts, market, areaMin: areaMin ? Number(areaMin) : null, areaMax: areaMax ? Number(areaMax) : null, rooms, sources, minPricePerSqm: minPricePerSqm ? Number(minPricePerSqm) : null, automaticScanEnabled, automaticScanTime } }),
      });
      const payload = await response.json() as { filters?: SettingsResponse["filters"]; message?: string };
      if (!response.ok || !payload.filters) throw new Error(payload.message || "Nie udało się zapisać filtrów Radaru.");
      setSettingsDirty(false);
      setError(null);
    } catch (reason) {
      setError(describeRadarRequestError(reason, "Nie udało się zapisać filtrów Radaru."));
    } finally { setSettingsSaving(false); }
  }, [districts, market, areaMin, areaMax, rooms, sources, minPricePerSqm, automaticScanEnabled, automaticScanTime]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !settingsDirty) return;
    const timeoutId = window.setTimeout(() => { void saveSettings(); }, 400);
    return () => window.clearTimeout(timeoutId);
  }, [settingsLoaded, settingsDirty, saveSettings]);

  const load = useCallback(async () => {
    if (!settingsLoaded) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      for (const district of districts) params.append("district", district);
      for (const source of sources) params.append("source", source);
      for (const room of rooms) params.append("rooms", String(room));
      params.set("market", market);
      if (areaMin) params.set("areaMin", areaMin);
      if (areaMax) params.set("areaMax", areaMax);
      if (minPricePerSqm) params.set("minPricePerSqm", minPricePerSqm);

      const response = await apiFetch(`/api/price-radar/results?${params.toString()}`);
      const payload = (await response.json()) as ResultsResponse | { message?: string };
      if (!response.ok || !("listings" in payload)) {
        throw new Error("message" in payload && payload.message ? payload.message : "Nie udało się pobrać wyników Radaru.");
      }
      setData(payload);
      setError(null);
    } catch (reason) {
      setError(describeRadarRequestError(reason, "Nie udało się pobrać wyników Radaru."));
    } finally {
      setIsLoading(false);
    }
  }, [settingsLoaded, districts, market, areaMin, areaMax, rooms, sources, minPricePerSqm]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const loadDistrictQueue = useCallback(async () => {
    try {
      const response = await apiFetch("/api/price-radar/district-queue");
      const payload = (await response.json()) as DistrictQueueResponse | { message?: string };
      if (!response.ok || !("pending" in payload)) {
        throw new Error("message" in payload && payload.message ? payload.message : "Nie udało się pobrać kolejki przypisania dzielnicy.");
      }
      setDistrictQueue(payload);
      setDistrictQueueError(null);
      // Prefill the dropdown with a suggestion the operator has not yet
      // overridden -- an explicit prior choice in state always wins, and
      // this never auto-assigns: "Dodaj do porównań" still requires the
      // operator's own click.
      const suggested = Object.fromEntries(payload.pending.filter((item) => item.suggestedDistrict).map((item) => [item.id, item.suggestedDistrict as string]));
      setDistrictChoices((current) => ({ ...suggested, ...current }));
    } catch (reason) {
      setDistrictQueueError(describeRadarRequestError(reason, "Nie udało się pobrać kolejki przypisania dzielnicy."));
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadDistrictQueue();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadDistrictQueue]);

  const assignDistrict = async (queueId: string) => {
    const district = districtChoices[queueId];
    if (!district) return;
    setDistrictQueuePending(queueId);
    try {
      const response = await apiFetch("/api/price-radar/district-queue/assign", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queueId, district }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Nie udało się dodać oferty do porównań.");
      setDistrictQueueError(null);
      // A confirmed save moves the offer into price_radar_listings --
      // both the queue and the A/B sample/stats must reflect this right away.
      await Promise.all([loadDistrictQueue(), load()]);
    } catch (reason) {
      setDistrictQueueError(describeRadarRequestError(reason, "Nie udało się dodać oferty do porównań."));
    } finally {
      setDistrictQueuePending(null);
    }
  };

  const setDistrictQueueRejection = async (queueId: string, rejected: boolean) => {
    setDistrictQueuePending(queueId);
    try {
      const response = await apiFetch("/api/price-radar/district-queue/reject", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queueId, rejected }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Nie udało się zaktualizować decyzji.");
      setDistrictQueueError(null);
      await loadDistrictQueue();
    } catch (reason) {
      setDistrictQueueError(describeRadarRequestError(reason, "Nie udało się zaktualizować decyzji."));
    } finally {
      setDistrictQueuePending(null);
    }
  };

  const loadVerificationQueue = useCallback(async () => {
    try {
      const response = await apiFetch("/api/price-radar/verification-queue");
      const payload = await response.json() as VerificationQueueResponse | { message?: string };
      if (!response.ok || !("pending" in payload)) throw new Error("message" in payload && payload.message ? payload.message : "Nie udało się pobrać kolejki weryfikacji.");
      setVerificationQueue(payload);
      setVerificationQueueError(null);
    } catch (reason) {
      setVerificationQueueError(describeRadarRequestError(reason, "Nie udało się pobrać kolejki weryfikacji."));
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => { void loadVerificationQueue(); }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadVerificationQueue]);

  const resolveVerification = async (queueId: string, decision: RadarVerificationDecision) => {
    setVerificationPending(queueId);
    try {
      const response = await apiFetch("/api/price-radar/verification-queue/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queueId, decision }),
      });
      const payload = await response.json() as { message?: string; reason?: string };
      if (!response.ok) throw new Error(payload.message || "Oferta nie przeszła ponownej kwalifikacji.");
      setVerificationQueueError(null);
      await Promise.all([loadVerificationQueue(), load()]);
    } catch (reason) {
      setVerificationQueueError(describeRadarRequestError(reason, "Nie udało się zatwierdzić oferty."));
    } finally { setVerificationPending(null); }
  };

  const setVerificationRejection = async (queueId: string, rejected: boolean) => {
    setVerificationPending(queueId);
    try {
      const response = await apiFetch("/api/price-radar/verification-queue/reject", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queueId, rejected }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Nie udało się zapisać decyzji.");
      setVerificationQueueError(null);
      await loadVerificationQueue();
    } catch (reason) {
      setVerificationQueueError(describeRadarRequestError(reason, "Nie udało się zapisać decyzji."));
    } finally { setVerificationPending(null); }
  };

  useEffect(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    let refreshing = false;
    const readRun = async (): Promise<RunStatus | null> => {
      const response = await apiFetch("/api/price-radar/run", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { run?: RunStatus | null } | null;
      if (!response.ok || !payload) throw new RadarHttpError(response.status, "Nie udało się odczytać stanu zbierania Radaru.");
      return payload.run ?? null;
    };
    const applyRun = (latest: RunStatus | null) => {
      if (cancelled) return;
      setRun(latest);
      setLastSyncedAt(Date.now());
      setConnectionNotice(null);
    };
    const refresh = async () => {
      // Visibility/online events can fire while a refresh is still awaiting
      // the network; one refresh at a time keeps a single poll timer alive.
      if (refreshing) return;
      refreshing = true;
      let nonterminal = false;
      try {
        const latest = await readRun();
        applyRun(latest);
        consecutiveFailures = 0;
        const latestNonterminal = latest?.status === "running" || latest?.status === "pending";
        nonterminal = latestNonterminal;
        const leaseExpired = latestNonterminal && (!latest.leaseUntil || !Number.isFinite(Date.parse(latest.leaseUntil)) || Date.parse(latest.leaseUntil) <= Date.now());
        const currentSource = radarRunActivity(latest).currentSource;
        const olxQueueOwnsSource = currentSource === "olx" && latest?.sourceStatuses.olx === "running"
          && (latest.olxJobStatus === "queued" || latest.olxJobStatus === "running" || latest.olxJobStatus === "missing" || latest.olxJobStatus === "unavailable");
        if (olxQueueOwnsSource && !cancelled) {
          setAutoResumeMessage(latest.olxJobStatus === "queued"
            ? "OLX: zadanie oczekuje w kolejce workera."
            : latest.olxJobStatus === "running" && latest.olxJobLeaseUntil && Date.parse(latest.olxJobLeaseUntil) > Date.now()
              ? "OLX: worker ma aktywny lease i pobiera oferty."
              : latest.olxJobStatus === "running"
                ? "OLX: zadanie ma status running, ale lease wygasł; oczekiwanie na kolejkę workera."
                : latest.olxJobStatus === "missing"
                  ? "OLX: nie znaleziono zadania dla tego przebiegu; stan wymaga sprawdzenia."
                  : "OLX: nie udało się odczytać stanu zadania workera.");
        }
        else if (latest?.stopRequestedAt && !cancelled) setAutoResumeMessage(leaseExpired
          ? "Zatrzymywanie oczekuje na zakończenie lease'u. Ponów żądanie zatrzymania, jeśli stan nie zmieni się po jego wygaśnięciu."
          : "Zatrzymywanie; bieżąca porcja kończy się bez rozpoczynania kolejnej pracy.");
        else if (leaseExpired && !cancelled) setAutoResumeMessage("Serwer kontynuuje przebieg od zapisanego checkpointu; oczekiwanie na kolejną porcję.");
        else if (!cancelled) setAutoResumeMessage(null);
        const attemptKey = latest ? `${latest.id}:${latest.leaseUntil ?? "none"}` : "";
        const priorAttempt = lastAutoResumeAttempt.current;
        const retryDelayElapsed = !priorAttempt || priorAttempt.key !== attemptKey || Date.now() - priorAttempt.at >= 30_000;
        // The server continues the run itself right after each portion. The
        // open PWA is only a fallback once the lease has stayed expired.
        const browserMayResume = leaseExpired && radarLeaseExpiredForBrowserResume(latest?.leaseUntil);
        if (!cancelled && browserMayResume && latest && !latest.stopRequestedAt && !olxQueueOwnsSource && !autoResumeInFlight.current && retryDelayElapsed && document.visibilityState !== "hidden") {
          autoResumeInFlight.current = true;
          lastAutoResumeAttempt.current = { key: attemptKey, at: Date.now() };
          if (!cancelled) setRunStarting(true);
          try {
            const resumed = await apiFetch("/api/price-radar/run", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRunId: latest.id }),
            });
            const resumePayload = await resumed.json().catch(() => null) as { code?: string; message?: string } | null;
            if (resumed.status === 409) {
              if (!cancelled) setAutoResumeMessage("Przebieg kontynuuje inny proces (serwer lub inne urządzenie); pobrano najnowszy stan z serwera.");
            } else if (!resumed.ok) {
              throw new RadarHttpError(resumed.status, resumePayload?.message || "Nie udało się automatycznie wznowić przebiegu Radaru.");
            } else if (!cancelled) {
              setAutoResumeMessage(null);
              await load();
            }
            const current = await readRun();
            applyRun(current);
            nonterminal = current?.status === "running" || current?.status === "pending";
          } finally {
            autoResumeInFlight.current = false;
            setRunStarting(false);
          }
        }
        if (!cancelled && leaseExpired && latest?.stopRequestedAt && !stopFinalizeInFlight.current) {
          // A worker can die after accepting STOP. The same owner-scoped,
          // idempotent STOP RPC finalizes the run after lease expiry; it never
          // claims or resumes collection work.
          stopFinalizeInFlight.current = true;
          try {
            const finalized = await apiFetch("/api/price-radar/run", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "stop", runId: latest.id }),
            });
            if (!finalized.ok && finalized.status !== 409) throw new RadarHttpError(finalized.status, "Nie udało się dokończyć zatrzymywania Radaru.");
            const refreshed = await readRun();
            applyRun(refreshed);
            nonterminal = refreshed?.status === "running" || refreshed?.status === "pending";
          } finally {
            stopFinalizeInFlight.current = false;
          }
        }
      } catch (reason) {
        consecutiveFailures += 1;
        if (!cancelled) {
          const issue = radarConnectionIssue(reason, navigator.onLine !== false);
          if (issue) setConnectionNotice(describeRadarRequestError(reason, "Nie udało się odczytać stanu zbierania Radaru."));
          else setError(describeRadarRequestError(reason, "Nie udało się odczytać stanu zbierania Radaru."));
        }
      } finally {
        refreshing = false;
        // Never stop polling: a single failed request (phone asleep, PWA in
        // background, flaky network) previously ended every later refresh.
        if (!cancelled) {
          if (timer !== undefined) window.clearTimeout(timer);
          timer = window.setTimeout(() => { void refresh(); }, radarRunPollDelayMs({ nonterminal, consecutiveFailures }));
        }
      }
    };
    const refreshNow = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refreshNow();
      void load();
    };
    const onOnline = () => {
      setConnectionNotice(null);
      refreshNow();
      void load();
    };
    const onOffline = () => setConnectionNotice(describeRadarRequestError(new TypeError("Failed to fetch"), "", false));
    refreshRunNow.current = refreshNow;
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (refreshRunNow.current === refreshNow) refreshRunNow.current = null;
    };
  }, [settingsLoaded, load]);

  const toggleDistrict = (district: string) => {
    setSettingsDirty(true);
    setDistricts((current) => (current.includes(district) ? current.filter((item) => item !== district) : [...current, district]));
  };
  const toggleRoom = (room: number) => {
    setSettingsDirty(true);
    setRooms((current) => (current.includes(room) ? current.filter((item) => item !== room) : [...current, room]));
  };
  const toggleSource = (source: RadarSource) => {
    setSettingsDirty(true);
    setSources((current) => (current.includes(source) ? current.filter((item) => item !== source) : [...current, source]));
  };

  const startCollection = async () => {
    autoResumeInFlight.current = true;
    setRunStarting(true);
    setError(null);
    try {
      const startingAfterTermination = Boolean(run?.userTerminatedAt);
      const stoppedRun = !startingAfterTermination && run && run.status === "partial" && run.errorMessage === "RADAR_STOPPED_BY_OPERATOR" && run.stopRequestedAt ? run : null;
      const response = await apiFetch("/api/price-radar/run", {
        method: "POST",
        ...((stoppedRun || startingAfterTermination) ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stoppedRun ? { expectedRunId: stoppedRun.id } : { action: "start_new" }),
        } : {}),
      });
      const payload = await response.json().catch(() => null) as { runId?: string; status?: RadarRunStatus; message?: string } | null;
      if (response.status === 409) {
        // Another device or the server's own continuation already owns the
        // run: show its real state instead of an error.
        await loadRunStatusNow();
        setAutoResumeMessage("Przebieg jest już prowadzony przez serwer lub inne urządzenie; pokazano najnowszy stan.");
        refreshRunNow.current?.();
        setError(null);
        return;
      }
      if (!response.ok) throw new RadarHttpError(response.status, payload?.message || "Nie udało się rozpocząć zbierania Radaru.");
      await loadRunStatusNow();
      await load();
      refreshRunNow.current?.();
      setError(null);
    } catch (reason) {
      setError(describeRadarRequestError(reason, "Nie udało się rozpocząć zbierania Radaru."));
    } finally {
      autoResumeInFlight.current = false;
      setRunStarting(false);
    }
  };

  const stopCollection = async () => {
    if (!run || (run.status !== "running" && run.status !== "pending") || runStopping) return;
    setRunStopping(true);
    setAutoResumeMessage("Zatrzymywanie; zachowuję wyniki i checkpoint bieżącego przebiegu.");
    try {
      const response = await apiFetch("/api/price-radar/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", runId: run.id }),
      });
      const payload = await response.json().catch(() => null) as { status?: "stopping" | "stopped"; code?: string; message?: string } | null;
      if (!response.ok || (payload?.status !== "stopping" && payload?.status !== "stopped")) {
        // A failed/blocked RPC must never leave the client displaying an
        // optimistic stop state. Refresh the authoritative run first, then
        // retain the server's bounded code and message for the operator.
        await loadRunStatusNow().catch(() => undefined);
        const serverMessage = [payload?.message, payload?.code].filter(Boolean).join(" · ");
        throw new Error(serverMessage || "Nie udało się zatrzymać przebiegu Radaru.");
      }
      setAutoResumeMessage(payload.status === "stopped"
        ? "Serwer potwierdził zatrzymanie przebiegu."
        : "Serwer przyjął STOP; oczekuje na potwierdzenie stanu lease.");
      await loadRunStatusNow();
      refreshRunNow.current?.();
      setError(null);
    } catch (reason) {
      setError(describeRadarRequestError(reason, "Nie udało się zatrzymać przebiegu Radaru."));
    } finally { setRunStopping(false); }
  };

  const terminateCollection = async () => {
    if (!run || !canTerminateRun(run) || runTerminating) return;
    setRunTerminating(true);
    setAutoResumeMessage("Zakończenie w toku; serwer zapisuje trwałą blokadę wznowienia.");
    try {
      const response = await apiFetch("/api/price-radar/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "terminate", runId: run.id }),
      });
      const payload = await response.json().catch(() => null) as { status?: "terminated"; code?: string; message?: string } | null;
      if (!response.ok || payload?.status !== "terminated") {
        await loadRunStatusNow().catch(() => undefined);
        const serverMessage = [payload?.message, payload?.code].filter(Boolean).join(" · ");
        throw new Error(serverMessage || "Nie udało się trwale zakończyć przebiegu Radaru.");
      }
      await loadRunStatusNow();
      setAutoResumeMessage("Serwer potwierdził trwałe zakończenie przebiegu.");
      refreshRunNow.current?.();
      setError(null);
    } catch (reason) {
      setError(describeRadarRequestError(reason, "Nie udało się trwale zakończyć przebiegu Radaru."));
    } finally { setRunTerminating(false); }
  };

  const loadRunStatusNow = async () => {
    const response = await apiFetch("/api/price-radar/run", { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { run?: RunStatus | null } | null;
    if (!response.ok || !payload) throw new RadarHttpError(response.status, "Nie udało się odczytać stanu Radaru.");
    setRun(payload.run ?? null);
    setLastSyncedAt(Date.now());
    setConnectionNotice(null);
  };

  const setExclusion = async (listingId: string, excluded: boolean) => {
    setPendingExclusion(listingId);
    try {
      const response = await apiFetch("/api/price-radar/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId, excluded }),
      });
      if (!response.ok) throw new Error("Nie udało się zaktualizować wykluczenia.");
      await load();
    } catch (reason) {
      setError(describeRadarRequestError(reason, "Nie udało się zaktualizować wykluczenia."));
    } finally {
      setPendingExclusion(null);
    }
  };

  const groupedStats = useMemo(() => data?.stats ?? [], [data]);
  // "W próbie" must count exactly the listings computeRadarStats() above also
  // counted (verificationIssues?.length === 0) -- the same split the server
  // already applies before averaging. A listing kept visible only pending
  // manual verification is a review candidate, never a qualified comparison,
  // so it gets its own section/count instead of inflating this one.
  const sampleListings = useMemo(() => (data?.listings ?? []).filter((listing) => (listing.verificationIssues?.length ?? 0) === 0), [data]);
  const reviewListings = useMemo(() => (data?.listings ?? []).filter((listing) => (listing.verificationIssues?.length ?? 0) > 0), [data]);
  const visibleSources = activeSourceIds.length ? SOURCE_OPTIONS.filter((option) => activeSourceIds.includes(option.value)) : [];

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader title="Radar cen po remoncie" description="Referencyjna cena ofertowa za m² dla mieszkań po pełnym remoncie (rynek wtórny) lub wykończonych pod klucz (rynek pierwotny), wyłącznie w blokach i apartamentowcach." />

      <section aria-label="Filtry Radaru" className="rounded-xl border bg-card p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dzielnice</p>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_RADAR_DISTRICTS.map((district) => (
                <button
                  key={district}
                  type="button"
                  aria-pressed={districts.includes(district)}
                  onClick={() => toggleDistrict(district)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${districts.includes(district) ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
                >
                  {district}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="price-radar-market" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rynek</label>
            <select
              id="price-radar-market"
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={market}
              onChange={(event) => { setSettingsDirty(true); setMarket(event.target.value as RadarMarketFilter); }}
            >
              <option value="both">Oba</option>
              <option value="secondary">Wtórny</option>
              <option value="primary">Pierwotny</option>
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metraż (m²)</p>
            <div className="flex items-center gap-2">
              <input type="number" min={0} placeholder="od" value={areaMin} onChange={(event) => { setSettingsDirty(true); setAreaMin(event.target.value); }} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
              <span className="text-muted-foreground">–</span>
              <input type="number" min={0} placeholder="do" value={areaMax} onChange={(event) => { setSettingsDirty(true); setAreaMax(event.target.value); }} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
            </div>
          </div>

          <div>
            <label htmlFor="price-radar-min-price-per-sqm" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Min. cena ofertowa za m²</label>
            <input id="price-radar-min-price-per-sqm" type="number" min={0} max={100000} step={100} placeholder="wyłączony" value={minPricePerSqm} onChange={(event) => { setSettingsDirty(true); setMinPricePerSqm(event.target.value); }} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
            <p className="mt-1 text-xs text-muted-foreground">Opcjonalny filtr porównań; standard oceniamy wyłącznie z danych oferty.</p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pokoje</p>
            <div className="flex flex-wrap gap-2">
              {ROOM_OPTIONS.map((room) => (
                <button
                  key={room}
                  type="button"
                  aria-pressed={rooms.includes(room)}
                  onClick={() => toggleRoom(room)}
                  className={`size-9 rounded-full border text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${rooms.includes(room) ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
                >
                  {room}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Portale</p>
          <div className="flex flex-wrap gap-2">
            {visibleSources.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={sources.includes(option.value) || sources.length === 0}
                onClick={() => toggleSource(option.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${sources.includes(option.value) || sources.length === 0 ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{disabledSourceNote || "Dostępne są wyłącznie źródła włączone we wspólnej bramce."} Filtr pusty oznacza wszystkie aktywne portale.</p>
        </div>
      </section>

      <section aria-label="Automatyczne skanowanie" className="min-w-0 space-y-4 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Automatyczne skanowanie</h2>
            <p className="mt-1 text-sm text-muted-foreground">Godziny według czasu polskiego (Europe/Warsaw)</p>
          </div>
          <span className={automaticScanEnabled ? "rounded-full bg-emerald-500/15 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300" : "rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"}>
            {automaticScanEnabled ? "Harmonogram włączony" : "Harmonogram wyłączony"}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
          <label className="flex min-h-10 items-center justify-between gap-3 font-medium">
            Automatyczny skan
            <span className="flex items-center gap-2">
              <input
                aria-label="Automatyczny skan"
                checked={automaticScanEnabled}
                disabled={!settingsLoaded}
                onChange={(event) => { setAutomaticScanEnabled(event.target.checked); setSettingsDirty(true); }}
                type="checkbox"
              />
              <span>{automaticScanEnabled ? "Włączony" : "Wyłączony"}</span>
            </span>
          </label>
          <label className="grid gap-1.5 text-sm">
            Godzina codziennego skanowania
            <input
              aria-label="Godzina codziennego skanowania"
              className="h-10 rounded-full border bg-background px-4"
              disabled={!settingsLoaded || !automaticScanEnabled}
              onChange={(event) => { setAutomaticScanTime(event.target.value); setSettingsDirty(true); }}
              type="time"
              value={automaticScanTime}
            />
          </label>
        </div>
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 xl:grid-cols-4">
          <AutomationMetric label="Ostatni skan" value={run ? formatDate(run.startedAt) : "Brak potwierdzonych danych"} />
          <AutomationMetric label="Czas trwania" value={run ? formatDuration(run.startedAt, run.finishedAt ?? run.userTerminatedAt, clockNow) : "—"} />
          <AutomationMetric label="Status" value={runActivity.status} />
          <AutomationMetric label="Następny skan" value={radarNextScanLabel(run, automaticScanEnabled, automaticScanTime, new Date(clockNow))} />
          <AutomationMetric label="Ostatni rzeczywisty postęp" value={run?.checkpoint?.progress?.lastRealProgressAt ? `${formatDate(run.checkpoint.progress.lastRealProgressAt)}${run.checkpoint.progress.lastProgressSource ? ` · ${radarSourceLabel(run.checkpoint.progress.lastProgressSource)}` : ""}` : run ? "Brak potwierdzonego postępu" : "—"} />
          <AutomationMetric label="Ostatni zapis checkpointu" value={runActivity.lastProgressAt ? formatDate(runActivity.lastProgressAt) : "Brak zapisanego checkpointu"} />
          <AutomationMetric label="Aktualne źródło" value={runActivity.currentSource ? radarSourceLabel(runActivity.currentSource) : "—"} />
          <AutomationMetric label="Pozostałe źródła" value={String(runActivity.remainingSources)} />
          {isRunActuallyActive(run) || run?.status === "running" || run?.status === "pending" ? <AutomationMetric label="Powód oczekiwania" value={radarWaitingLabel(run)} /> : null}
          {run?.checkpoint?.progress?.lastContinuationError ? <AutomationMetric label="Ostatni błąd przekazania" value={`${formatDate(run.checkpoint.progress.lastContinuationError.at)} · krok ${run.checkpoint.progress.lastContinuationError.hop} · ${run.checkpoint.progress.lastContinuationError.reason}`} /> : null}
          <AutomationMetric label="Ostatnia synchronizacja z serwerem" value={lastSyncedAt ? formatDate(new Date(lastSyncedAt).toISOString()) : "—"} />
        </div>
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 xl:grid-cols-4">
          <AutomationMetric label="Sprawdzono" value={run ? String(run.scannedCount) : "—"} />
          <AutomationMetric label="Zakwalifikowano" value={run ? String(run.qualifiedCount) : "—"} />
          <AutomationMetric label="Odrzucono" value={typeof run?.checkpoint?.rejectedCount === "number" ? String(run.checkpoint.rejectedCount) : "—"} />
          <AutomationMetric label="Skierowano do weryfikacji" value={run && typeof run.checkpoint?.verificationQueuedCount === "number" && typeof run.checkpoint?.districtQueuedCount === "number" ? String(run.checkpoint.verificationQueuedCount + run.checkpoint.districtQueuedCount) : "—"} />
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {settingsSaving ? "Zapisywanie ustawień…" : settingsDirty ? "Zmiany oczekują na zapis." : "Godzina jest zapisana w ustawieniach Radaru. Po każdej porcji serwer sam kontynuuje ten sam checkpoint, więc zamknięcie aplikacji nie przerywa skanu portali HTTP (OLX obsługuje osobny worker)."}
        </p>
      </section>

      <section aria-label="Zbieranie ofert Radaru" className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">Zbieranie Radaru</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">{run ? `${runActivity.status} · ${run.scannedCount} sprawdzonych · ${run.qualifiedCount} zakwalifikowanych · start ${formatDate(run.startedAt)} · czas ${formatDuration(run.startedAt, run.finishedAt ?? run.userTerminatedAt, clockNow)}` : "Brak uruchomionego przebiegu."}</p>
          {run?.sourceErrors && Object.keys(run.sourceErrors).length > 0 ? <ul className="mt-2 space-y-1 text-xs text-destructive">{Object.entries(run.sourceErrors).map(([source, message]) => <li className="break-words" key={source}>{source}: {message}</li>)}</ul> : null}
          {run?.sourceRejectionCounts && Object.keys(run.sourceRejectionCounts).length > 0 ? <details aria-label="Odrzucone kandydatury źródeł" className="mt-2 text-xs"><summary className="cursor-pointer font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">Odrzucone kandydatury według źródła</summary><ul className="mt-2 space-y-1 text-muted-foreground">{Object.entries(run.sourceRejectionCounts).map(([source, counts]) => { const reasons = Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0); return reasons.length ? <li className="break-words" key={source}><span className="font-semibold">{radarSourceLabel(source)}:</span> {reasons.map(([reason, count]) => `${sourceRejectionLabel(reason)} · ${count}`).join("; ")}</li> : null; })}</ul></details> : null}
          {run?.checkpoint?.progress?.metrics ? <RadarPerformanceDetails run={run} now={clockNow} /> : null}
          {run?.sourceWarnings && Object.values(run.sourceWarnings).some((warnings) => warnings.length > 0) ? <details aria-label="Uwagi i pokrycie źródeł" className="mt-2 text-xs"><summary className="cursor-pointer font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">Uwagi źródeł i zakres wyszukiwania</summary><ul className="mt-2 space-y-1 text-muted-foreground">{Object.entries(run.sourceWarnings).map(([source, warnings]) => warnings.length ? <li className="break-words" key={source}><span className="font-semibold">{radarSourceLabel(source)}:</span> {warnings.map(sourceWarningLabel).join("; ")}</li> : null)}</ul></details> : null}
          {run?.qualificationRejections && Object.values(run.qualificationRejections).some((counts) => Object.keys(counts).length > 0) ? <details aria-label="Powody odrzucenia ofert" className="mt-2 text-xs"><summary className="cursor-pointer font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">Powody odrzucenia w kwalifikacji</summary><ul className="mt-2 space-y-1 text-muted-foreground">{Object.entries(run.qualificationRejections).map(([source, counts]) => { const reasons = Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0); return reasons.length ? <li className="break-words" key={source}><span className="font-semibold">{radarSourceLabel(source)}:</span> {reasons.map(([reason, count]) => `${qualificationRejectionLabel(reason)} · ${count}`).join("; ")}</li> : null; })}</ul></details> : null}
          {autoResumeMessage ? <p className="mt-2 text-xs text-muted-foreground">{autoResumeMessage}</p> : null}
          {connectionNotice ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status">{connectionNotice}{run ? ` Ostatni znany stan: ${run.scannedCount} sprawdzonych, ${run.qualifiedCount} zakwalifikowanych${runActivity.lastProgressAt ? `, zapis postępu ${formatDate(runActivity.lastProgressAt)}` : ""}.` : ""}</p> : null}
          {settingsSaving ? <p className="mt-1 text-xs text-muted-foreground">Zapisywanie ustawień…</p> : settingsDirty ? <p className="mt-1 text-xs text-destructive">Ustawienia nie zostały zapisane. Zmiana zostanie ponowiona po kolejnej edycji.</p> : null}
        </div>
        <Button disabled={runStarting || runStopping || runTerminating || Boolean(run?.stopRequestedAt && (run.status === "running" || run.status === "pending")) || (isRunActuallyActive(run) && !(run?.status === "partial" && run.errorMessage === "RADAR_STOPPED_BY_OPERATOR")) || !settingsLoaded} onClick={() => void startCollection()}>
          {runStarting ? "Uruchamianie…" : run?.userTerminatedAt ? "Uruchom nowy przebieg" : run?.status === "partial" && run.errorMessage === "RADAR_STOPPED_BY_OPERATOR" ? "Wznów zatrzymany przebieg" : run?.stopRequestedAt && (run.status === "running" || run.status === "pending") ? "Zatrzymywanie…" : isRunActuallyActive(run) ? "Przebieg trwa" : "Uruchom / wznów zbieranie"}
        </Button>
        {(run?.status === "running" || run?.status === "pending") ? (
          <Button variant="outline" disabled={runStopping || runTerminating || Boolean(run.stopRequestedAt && isRunActuallyActive(run))} onClick={() => void stopCollection()}>
            {runStopping ? "Zatrzymywanie…" : run.stopRequestedAt && !isRunActuallyActive(run) ? "Dokończ zatrzymanie" : run.stopRequestedAt ? "Zatrzymywanie…" : "Zatrzymaj"}
          </Button>
        ) : null}
        {run && canTerminateRun(run) ? (
          <Button variant="outline" disabled={runStopping || runTerminating} onClick={() => void terminateCollection()}>
            {runTerminating ? "Zakończenie w toku…" : "Zakończ przebieg"}
          </Button>
        ) : null}
        {run?.sourceStatuses ? <div className="flex w-full min-w-0 flex-wrap gap-2 text-xs">{Object.entries(run.sourceStatuses).map(([source, status]) => <span className="max-w-full break-words rounded-full border px-2 py-1" key={source}>{radarSourceLabel(source)}: {radarSourceActivityLabel(run, source, status, clockNow)}</span>)}</div> : null}
      </section>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      <section aria-label="Statystyki Radaru" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groupedStats.length === 0 && !isLoading ? (
          // A run's own historical qualifiedCount (shown above, in "Zbieranie
          // Radaru") can stay at its old value while every one of those
          // listings is later excluded, superseded, or kept out of A/B as a
          // review candidate -- leaving the CURRENT sample genuinely empty.
          // That is still a real, reportable zero, not "no data": it must
          // show the true count and "Niewystarczająca próba", never an
          // average/median (there is nothing to average), and never the
          // historical run counter re-used as if it were today's sample.
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold">Wybrane filtry</p>
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Niewystarczająca próba</span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">0 mieszkań · brak ceny referencyjnej (minimum {MIN_RADAR_SAMPLE_SIZE})</p>
          </div>
        ) : null}
        {groupedStats.map((group) => (
          <div key={`${group.district}-${group.marketType}-${group.qualityCategory}`} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{group.district} · {group.marketType === "primary" ? "Pierwotny" : "Wtórny"} · {qualityCategoryLabel(group.qualityCategory, group.marketType)}</p>
              {group.isSmallSample ? (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Niewystarczająca próba</span>
              ) : null}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <MetricCard label="Średnia zł/m²" value={group.averagePricePerSqm ? formatCurrency(group.averagePricePerSqm) : "—"} />
              <MetricCard label="Mediana zł/m²" value={group.medianPricePerSqm ? formatCurrency(group.medianPricePerSqm) : "—"} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {group.sampleSize} {group.sampleSize === 1 ? "mieszkanie" : "mieszkań"} · {group.sampleSize < MIN_RADAR_SAMPLE_SIZE ? `brak ceny referencyjnej (minimum ${MIN_RADAR_SAMPLE_SIZE})` : "ceny ofertowe w próbie"}
              {group.updatedAt ? ` · aktualizacja ${formatDate(group.updatedAt)}` : ""}
            </p>
          </div>
        ))}
      </section>

      {districtQueueError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{districtQueueError}</div>
      ) : null}

      {districtQueue && !districtQueue.available ? (
        <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          Kolejka przypisania dzielnicy jest niedostępna. Wymaga zastosowania migracji <code>20261011154631_add_radar_district_queue.sql</code>; kandydaci nie są obecnie zapisywani do kolejki.
        </div>
      ) : null}

      {districtQueue && (districtQueue.pending.length > 0 || districtQueue.rejected.length > 0) ? (
        <section aria-label="Do przypisania dzielnicy" className="space-y-3">
          <h2 className="text-lg font-semibold">Do przypisania dzielnicy ({districtQueue.pending.length})</h2>
          <p className="text-xs text-muted-foreground">
            Mieszkania spełniające pozostałe kryteria Radaru (cena, metraż, pokoje, rynek, blok/apartamentowiec, standard A/B), którym brakuje wyłącznie potwierdzonej dzielnicy.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {districtQueue.pending.map((item) => (
              <DistrictQueueRow
                key={item.id}
                item={item}
                chosenDistrict={districtChoices[item.id] ?? ""}
                onChooseDistrict={(district) => setDistrictChoices((current) => ({ ...current, [item.id]: district }))}
                onAssign={() => void assignDistrict(item.id)}
                onReject={() => void setDistrictQueueRejection(item.id, true)}
                pending={districtQueuePending === item.id}
              />
            ))}
          </div>

          {districtQueue.rejected.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-muted-foreground">Odrzucone z kolejki dzielnic ({districtQueue.rejected.length})</h3>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                {districtQueue.rejected.map((item) => (
                  <DistrictQueueRow
                    key={item.id}
                    item={item}
                    rejected
                    chosenDistrict={districtChoices[item.id] ?? ""}
                    onChooseDistrict={(district) => setDistrictChoices((current) => ({ ...current, [item.id]: district }))}
                    onAssign={() => void assignDistrict(item.id)}
                    onReject={() => void setDistrictQueueRejection(item.id, false)}
                    pending={districtQueuePending === item.id}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {verificationQueueError ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{verificationQueueError}</div>
      ) : null}
      {verificationQueue && !verificationQueue.available ? (
        <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          Kolejka weryfikacji danych i standardu wymaga lokalnego draftu <code>20261012130000_add_price_radar_verification_queue.sql</code>. Nie została zastosowana w Production.
        </div>
      ) : null}
      {verificationQueue?.available && verificationQueue.pending.length > 0 ? (
        <section aria-label="Do weryfikacji danych i standardu" className="space-y-3">
          <h2 className="text-lg font-semibold">Do weryfikacji danych i standardu ({verificationQueue.pending.length})</h2>
          <p className="text-sm text-muted-foreground">To nie są jeszcze porównania ani próbka statystyczna. Potwierdź konkretne wartości z ogłoszenia.</p>
          <div className="grid gap-4 lg:grid-cols-2">
            {verificationQueue.pending.map((item) => (
              <VerificationQueueRow key={item.id} item={item} pending={verificationPending === item.id}
                onResolve={(decision) => void resolveVerification(item.id, decision)} onReject={() => void setVerificationRejection(item.id, true)} />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="Oferty w próbie" className="space-y-3">
        <h2 className="text-lg font-semibold">Oferty w próbie ({sampleListings.length})</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {sampleListings.map((listing) => (
            <ListingRow key={listing.id} listing={listing} onExclude={() => void setExclusion(listing.id, true)} pending={pendingExclusion === listing.id} />
          ))}
        </div>

        {reviewListings.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-muted-foreground">Do weryfikacji · poza próbą A/B ({reviewListings.length})</h3>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {reviewListings.map((listing) => (
                <ListingRow key={listing.id} listing={listing} onExclude={() => void setExclusion(listing.id, true)} pending={pendingExclusion === listing.id} />
              ))}
            </div>
          </div>
        ) : null}

        {data && data.excludedListings.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-muted-foreground">Wykluczone z porównań ({data.excludedListings.length})</h3>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {data.excludedListings.map((listing) => (
                <ListingRow key={listing.id} listing={listing} excluded onExclude={() => void setExclusion(listing.id, false)} pending={pendingExclusion === listing.id} />
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ListingRow({ listing, excluded, onExclude, pending }: { listing: RadarListing; excluded?: boolean; onExclude: () => void; pending: boolean }) {
  return (
    <article className={`min-w-0 overflow-hidden rounded-xl border bg-card p-4 ${excluded ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{listing.title ?? "Oferta bez tytułu"}</h3>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <span className="max-w-32 break-words rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{sourceLabel(listing.source)}</span>
          {listing.verificationIssues?.length ? <span className="max-w-48 break-words rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300" title={`Poza statystykami A/B: ${listing.verificationIssues.map(verificationIssueLabel).join(", ")}`}>Wymaga weryfikacji · poza próbą A/B</span> : null}
        </div>
      </div>
      <p className="mt-1 break-words text-sm text-muted-foreground">{listing.district}, {listing.city} · {listing.marketType === "primary" ? "Pierwotny" : "Wtórny"} · {listing.buildingType === "blok" ? "Blok" : "Apartamentowiec"}{listing.yearBuilt !== null ? ` · Rok budowy: ${listing.yearBuilt}` : " · Rok budowy: brak danych"}{listing.verificationIssues?.length ? " · poza klasyfikacją A/B do czasu weryfikacji" : ` · ${qualityCategoryLabel(listing.qualityCategory, listing.marketType)}`}</p>
      {listing.verificationIssues?.length ? <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-300">Sprzeczne dane: {listing.verificationIssues.map(verificationIssueLabel).join(", ")}. Oferta pozostaje zachowana, ale nie wchodzi do statystyk.</p> : null}
      <p className="type-financial-standard mt-3 text-sm font-medium tabular-nums">
        {formatCurrency(listing.price)} · {listing.area} m² · {formatCurrency(listing.pricePerSqm)}/m²{listing.rooms ? ` · ${listing.rooms} pok.` : ""}
      </p>
      <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
        <DateRow label="Opublikowano" value={listing.publishedAt} />
        <DateRow label="Zmiana ogłoszenia" value={listing.sourceUpdatedAt} />
        <DateRow label="Pobrano" value={listing.collectedAt} />
      </dl>
      {listing.crossSourceAlternates.length > 0 ? <div className="mt-2 space-y-2 text-xs"><p className="font-semibold">Znaleziono także na: {listing.crossSourceAlternates.map((item) => sourceLabel(item.source)).filter((source, index, all) => all.indexOf(source) === index).join(", ")}</p>{listing.crossSourceAlternates.map((item) => <a className="grid break-words rounded-lg border border-border/60 p-2 text-primary underline sm:grid-cols-[minmax(0,1fr)_auto]" href={item.originalUrl} key={`${item.source}:${item.id}`} rel="noreferrer" target="_blank"><span>{sourceLabel(item.source)} · {item.title ?? "Ogłoszenie"} · {formatCurrency(item.price)} · {item.area} m²{item.rooms ? ` · ${item.rooms} pok.` : ""}</span><span>Opublikowano: {item.publishedAt ? formatDate(item.publishedAt) : "nie podano"} · pobrano: {formatDate(item.collectedAt)}</span></a>)}</div> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button nativeButton={false} render={<a href={listing.originalUrl} target="_blank" rel="noopener noreferrer" />} size="sm" variant="outline">
          Otwórz ogłoszenie
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onExclude}>
          {excluded ? "Przywróć do porównań" : "Wyklucz z porównań"}
        </Button>
      </div>
    </article>
  );
}

function DistrictQueueRow({ item, rejected, chosenDistrict, onChooseDistrict, onAssign, onReject, pending }: {
  item: RadarDistrictQueueItem; rejected?: boolean; chosenDistrict: string; onChooseDistrict: (district: string) => void;
  onAssign: () => void; onReject: () => void; pending: boolean;
}) {
  const selectId = `district-queue-select-${item.id}`;
  return (
    <article className={`min-w-0 overflow-hidden rounded-xl border bg-card p-4 ${rejected ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{item.title ?? "Oferta bez tytułu"}</h3>
        <span className="max-w-32 break-words rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{sourceLabel(item.source)}</span>
      </div>
      <p className="mt-1 break-words text-sm text-muted-foreground">
        {item.city} · {item.marketType === "primary" ? "Pierwotny" : "Wtórny"} · {item.buildingType === "blok" ? "Blok" : "Apartamentowiec"} · {qualityCategoryLabel(item.qualityCategory, item.marketType)}
      </p>
      <p className="mt-1 break-words text-xs font-medium text-amber-700 dark:text-amber-300">Dzielnica wymaga przypisania</p>
      {item.suggestedDistrict ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          Podpowiedź ({item.suggestionSource === "gis" ? "mapa Łodzi" : "AI"}): <span className="font-medium text-foreground">{item.suggestedDistrict}</span>
          {item.suggestionEvidence ? <> — „{item.suggestionEvidence}”</> : null}. Wymaga potwierdzenia operatora.
        </p>
      ) : null}
      {item.description ? <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{item.description}</p> : null}
      <p className="type-financial-standard mt-3 text-sm font-medium tabular-nums">
        {formatCurrency(item.price)} · {item.area} m² · {formatCurrency(item.pricePerSqm)}/m²{item.rooms ? ` · ${item.rooms} pok.` : ""}
      </p>
      <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
        <DateRow label="Opublikowano" value={item.publishedAt} />
        <DateRow label="Zmiana ogłoszenia" value={item.sourceUpdatedAt} />
        <DateRow label="Pobrano" value={item.collectedAt} />
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button nativeButton={false} render={<a href={item.originalUrl} target="_blank" rel="noopener noreferrer" />} size="sm" variant="outline">
          Otwórz ogłoszenie
        </Button>
        {!rejected ? (
          <>
            <label htmlFor={selectId} className="sr-only">Dzielnica</label>
            <select
              id={selectId}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
              value={chosenDistrict}
              disabled={pending}
              onChange={(event) => onChooseDistrict(event.target.value)}
            >
              <option value="">Wybierz dzielnicę</option>
              {DEFAULT_RADAR_DISTRICTS.map((district) => (
                <option key={district} value={district}>{district}</option>
              ))}
            </select>
            <Button size="sm" disabled={pending || !chosenDistrict} onClick={onAssign}>
              Dodaj do porównań
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={onReject}>
              Odrzuć
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={onReject}>
            Przywróć do kolejki
          </Button>
        )}
      </div>
    </article>
  );
}

// Pokazuje wyłącznie pola operatora: nazwę, link, edytowalne dane i
// potwierdzenie zgodności. Techniczne dowody źródłowe, powód skierowania i
// sugestia AI pozostają w snapshocie (backend, testy), ale nie są tu
// renderowane -- operator ocenia ofertę z samego ogłoszenia, nie z
// diagnostyki parsera.
function VerificationQueueRow({ item, pending, onResolve, onReject }: {
  item: RadarVerificationQueueItem;
  pending: boolean;
  onResolve: (decision: RadarVerificationDecision) => void;
  onReject: () => void;
}) {
  const [price, setPrice] = useState(item.snapshot.confirmedFields.includes("total_price") && item.snapshot.price ? String(item.snapshot.price) : "");
  const [area, setArea] = useState(item.snapshot.confirmedFields.includes("area") && item.snapshot.area ? String(item.snapshot.area) : "");
  const [rooms, setRooms] = useState(item.snapshot.confirmedFields.includes("rooms") && item.snapshot.rooms ? String(item.snapshot.rooms) : "");
  const [city, setCity] = useState(item.snapshot.confirmedFields.includes("city_lodz") && item.snapshot.city === "Łódź" ? "Łódź" : "");
  const [district, setDistrict] = useState(item.snapshot.confirmedFields.includes("district") ? item.snapshot.district ?? "" : item.snapshot.suggestedDistrict ?? "");
  const [buildingType, setBuildingType] = useState(item.snapshot.confirmedFields.includes("building_type") && (item.snapshot.buildingType === "blok" || item.snapshot.buildingType === "apartamentowiec") ? item.snapshot.buildingType : "");
  const [marketType, setMarketType] = useState(item.snapshot.confirmedFields.includes("market_type") && (item.snapshot.marketType === "primary" || item.snapshot.marketType === "secondary") ? item.snapshot.marketType : "");
  const [qualityCategory, setQualityCategory] = useState(item.snapshot.confirmedFields.includes("standard") ? item.snapshot.qualityCategory ?? "" : "");
  const [apartmentSaleConfirmed, setApartmentSaleConfirmed] = useState(false);
  const parsedPrice = Number(price);
  const parsedArea = Number(area);
  const pricePerSqm = Number.isFinite(parsedPrice) && parsedPrice > 0 && Number.isFinite(parsedArea) && parsedArea > 0 ? parsedPrice / parsedArea : null;
  const canSubmit = apartmentSaleConfirmed && pricePerSqm !== null && Number.isInteger(Number(rooms)) && Number(rooms) > 0
    && city.trim().toLocaleLowerCase("pl-PL") === "łódź"
    && (DEFAULT_RADAR_DISTRICTS as readonly string[]).includes(district)
    && (buildingType === "blok" || buildingType === "apartamentowiec")
    && (marketType === "primary" || marketType === "secondary")
    && (qualityCategory === "fresh_renovation" || qualityCategory === "ready_high_standard");

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{item.title ?? "Oferta bez tytułu"}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{sourceLabel(item.source)}</span>
      </div>
      <a className="mt-2 block break-all text-xs text-primary underline" href={item.originalUrl} target="_blank" rel="noopener noreferrer">Otwórz konkretne ogłoszenie</a>
      <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">Cena całkowita, zł<input className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" type="number" min="1" step="1" value={price} disabled={pending} onChange={(event) => setPrice(event.target.value)} /></label>
        <label className="grid gap-1 text-xs">Powierzchnia, m²<input className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" type="number" min="1" step="0.01" value={area} disabled={pending} onChange={(event) => setArea(event.target.value)} /></label>
        <div className="grid gap-1 text-xs">
          <span id={`${item.id}-price-per-sqm-label`}>Cena za m²</span>
          <div aria-labelledby={`${item.id}-price-per-sqm-label`} className="flex h-9 min-w-0 items-center rounded-lg border border-input bg-muted/40 px-2 text-sm tabular-nums">
            {pricePerSqm === null ? "Uzupełnij poprawną cenę i metraż" : `${formatCurrency(pricePerSqm)}/m²`}
          </div>
        </div>
        <label className="grid gap-1 text-xs">Pokoje<input className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" type="number" min="1" max="20" step="1" value={rooms} disabled={pending} onChange={(event) => setRooms(event.target.value)} /></label>
        <label className="grid gap-1 text-xs">Miasto — potwierdź z ogłoszenia<input className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" value={city} disabled={pending} onChange={(event) => setCity(event.target.value)} /></label>
        <label className="grid gap-1 text-xs">Dzielnica<select className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" value={district} disabled={pending} onChange={(event) => setDistrict(event.target.value)}><option value="">Wybierz</option>{DEFAULT_RADAR_DISTRICTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Typ budynku<select className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" value={buildingType} disabled={pending} onChange={(event) => setBuildingType(event.target.value)}><option value="">Wybierz</option><option value="blok">Blok</option><option value="apartamentowiec">Apartamentowiec</option></select></label>
        <label className="grid gap-1 text-xs">Rynek<select className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" value={marketType} disabled={pending} onChange={(event) => setMarketType(event.target.value)}><option value="">Wybierz</option><option value="secondary">Wtórny</option><option value="primary">Pierwotny</option></select></label>
        <label className="grid gap-1 text-xs">Standard<select className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm" value={qualityCategory} disabled={pending} onChange={(event) => setQualityCategory(event.target.value)}><option value="">Wybierz</option><option value="fresh_renovation">A · świeży pełny remont</option><option value="ready_high_standard">B · gotowe, wysoki standard</option></select></label>
        <label className="flex min-w-0 items-start gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={apartmentSaleConfirmed} disabled={pending} onChange={(event) => setApartmentSaleConfirmed(event.target.checked)} /><span>Potwierdzam z ogłoszenia, że to konkretne mieszkanie na sprzedaż, a wybrane wartości i standard dotyczą tego lokalu.</span></label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button size="sm" disabled={pending || !canSubmit} onClick={() => onResolve({ apartmentSaleConfirmed: true, price: parsedPrice, area: parsedArea, rooms: Number(rooms), city: "Łódź", district: district as RadarVerificationDecision["district"], buildingType: buildingType as RadarVerificationDecision["buildingType"], marketType: marketType as RadarVerificationDecision["marketType"], qualityCategory: qualityCategory as RadarQualityCategory })}>Potwierdź i dodaj do porównań</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={onReject}>Odrzuć</Button>
        </div>
      </div>
    </article>
  );
}

function DateRow({ label, value }: { label: string; value: string | null }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2"><dt>{label}</dt><dd className="break-words text-right">{value ? formatDate(value) : "Nie podano"}</dd></div>;
}

function sourceLabel(source: RadarSource): string {
  return SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;
}

function qualityCategoryLabel(category: RadarQualityCategory, market: "primary" | "secondary"): string {
  if (category === "ready_high_standard") return "B · Gotowe — wysoki standard";
  return market === "primary" ? "A · Wykończone pod klucz" : "A · Po świeżym remoncie";
}

function verificationIssueLabel(issue: string): string {
  return ({ area: "metraż", rooms: "liczba pokoi", floor: "piętro", location: "lokalizacja" } as Record<string, string>)[issue] ?? issue;
}

function AutomationMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-words font-medium">{value}</p></div>;
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function RadarPerformanceDetails({ run, now }: { run: RunStatus; now: number }) {
  const metrics = run.checkpoint?.progress?.metrics;
  if (!metrics) return null;
  const activeMinutes = metrics.httpActiveMs / 60_000;
  const throughput = activeMinutes > 0 ? Math.round(run.scannedCount / activeMinutes) : null;
  const olxWaitingSince = run.sourceStatuses.olx === "running" && metrics.olxEnqueuedAt ? metrics.olxEnqueuedAt : null;
  const httpWall = metrics.httpStartedAt ? formatDuration(metrics.httpStartedAt, metrics.httpFinishedAt ?? null, now) : "—";
  const sources = Object.entries(metrics.sources).filter(([, item]) => item.attempts > 0);
  return (
    <details aria-label="Wydajność przebiegu" className="mt-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">Wydajność przebiegu</summary>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        <li>Portale HTTP: aktywna praca {formatSeconds(metrics.httpActiveMs)} · od startu do końca {httpWall}{metrics.httpFinishedAt ? "" : " (w toku)"} · porcje {metrics.portions}</li>
        <li>Przekazania między porcjami: {metrics.handOffs} · łącznie {formatSeconds(metrics.handOffGapMs)}{metrics.handOffs > 0 ? ` (średnio ${formatSeconds(metrics.handOffGapMs / metrics.handOffs)})` : ""}</li>
        <li>Przepustowość: {throughput === null ? "—" : `${throughput} ofert/min aktywnej pracy`}</li>
        <li>Worker OLX: {olxWaitingSince ? `oczekiwanie od ${formatDate(olxWaitingSince)} (${formatDuration(olxWaitingSince, null, now)}), liczone osobno od portali HTTP` : metrics.olxEnqueuedAt ? `przekazano ${formatDate(metrics.olxEnqueuedAt)}` : "jeszcze nie przekazano"}</li>
        {sources.map(([source, item]) => (
          <li className="break-words" key={source}>
            <span className="font-semibold">{radarSourceLabel(source)}:</span> {formatSeconds(item.activeMs)} · żądania: lista {item.listRequests}, szczegóły {item.detailRequests}{item.contextRequests ? `, kontekst ${item.contextRequests}` : ""} · oferty {item.fetched}{item.activeMs > 0 ? ` · ${Math.round(item.fetched / (item.activeMs / 60_000))}/min` : ""} · baza {formatSeconds(item.dbMs + item.checkpointMs)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatDuration(startedAt: string, finishedAt: string | null, now: number): string {
  const started = Date.parse(startedAt);
  const ended = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "—";
  const totalMinutes = Math.max(0, Math.floor((ended - started) / 60_000));
  if (totalMinutes < 1) return "mniej niż minutę";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return String(minutes) + " min";
  return minutes === 0 ? String(hours) + " godz." : String(hours) + " godz. " + String(minutes) + " min";
}

function radarSourceActivityLabel(run: RunStatus, source: string, status: string, now: number): string {
  const attempts = run.checkpoint?.progress?.sourceNoProgressAttempts?.[source] ?? 0;
  const base = radarSourceBaseActivityLabel(run, source, status, now);
  return attempts > 0 && status !== "completed" && status !== "failed" && status !== "partial" ? `${base} · próby bez postępu: ${attempts}` : base;
}

function radarWaitingLabel(run: RunStatus | null): string {
  const progress = run?.checkpoint?.progress;
  const noProgress = progress?.noProgressPortions ?? 0;
  const suffix = noProgress > 0 ? ` · porcje bez postępu: ${noProgress}` : "";
  switch (progress?.waitingReason) {
    case "retry_after": return `Portal poprosił o przerwę (Retry-After)${progress.waitingUntil ? ` do ${formatDate(progress.waitingUntil)}` : ""}${suffix}`;
    case "olx_worker": return `Worker OLX${suffix}`;
    case "next_portion": return `Następna porcja na serwerze${suffix}`;
    default: return noProgress > 0 ? `Brak postępu${suffix}` : "—";
  }
}

function radarSourceBaseActivityLabel(run: RunStatus, source: string, status: string, now: number): string {
  if (status !== "running") return ({ pending: "oczekuje", completed: "ukończono", partial: "częściowe pokrycie", failed: "błąd terminalny" } as Record<string, string>)[status] ?? "nieznany";
  if (source === "olx") {
    if (run.olxJobStatus === "queued") return "oczekuje na worker";
    if (run.olxJobStatus === "running" && run.olxJobLeaseUntil && Date.parse(run.olxJobLeaseUntil) > now) return "worker pobiera";
    if (run.olxJobStatus === "failed") return "błąd terminalny workera";
    if (run.olxJobStatus === "unavailable") return "stan workera niepotwierdzony";
    return "oczekuje na kontynuację";
  }
  return isRunActuallyActive(run) ? "pobieranie" : "oczekuje na kontynuację";
}

function radarNextScanLabel(run: RunStatus | null, enabled: boolean, time: string, now: Date): string {
  if (!enabled) return "Wyłączony";
  if (run?.stopRequestedAt || run?.errorMessage === "RADAR_STOPPED_BY_OPERATOR") return "Wymaga wznowienia przez operatora";
  if (run && (run.status === "running" || run.status === "pending") && !run.userTerminatedAt) {
    return run.sourceStatuses.olx === "running" ? "Oczekuje na worker OLX" : isRunActuallyActive(run) ? "Kontynuuje ten sam przebieg" : "Wznowienie checkpointu przy najbliższym ticku";
  }
  const input = { enabled, time, lastStartedAt: run?.startedAt };
  if (isRadarDailyScanDue(input, now)) return "Oczekuje na kontroler (co 5 min)";
  const next = nextRadarDailyScanAt(input, now);
  return next ? formatDate(next.toISOString()) : "Nie można wyznaczyć";
}

/**
 * status === "running" alone does not mean a claim is still held: the
 * owning portion's lease can expire (a crashed/disconnected local OLX
 * worker, a timed-out request) without anything ever flipping the run's own
 * status row. The server's own claim RPC already treats an expired lease as
 * reclaimable, so the UI must not block the operator from retrying past a
 * stale "running" label -- that would leave an orphaned run with no way to
 * resume it short of direct database access.
 */
function isRunActuallyActive(run: RunStatus | null): boolean {
  if (!run || (run.status !== "running" && run.status !== "pending")) return false;
  if (!run.leaseUntil) return false;
  return new Date(run.leaseUntil).getTime() > Date.now();
}

function canTerminateRun(run: RunStatus): boolean {
  return !run.userTerminatedAt && (run.status === "running" || run.status === "pending"
    || (run.status === "partial" && run.errorMessage === "RADAR_STOPPED_BY_OPERATOR" && Boolean(run.stopRequestedAt)));
}

function radarSourceLabel(source: string): string {
  return SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;
}

function qualificationRejectionLabel(reason: string): string {
  const labels: Record<string, string> = {
    detail_not_confirmed: "brak potwierdzonych danych szczegółowych",
    detail_conflict: "sprzeczne dane o tym samym mieszkaniu; oferta wymaga weryfikacji",
    listing_identity_changed: "portalowe ID wskazuje istotnie zmienione mieszkanie; wymagana weryfikacja",
    price_missing: "brak ceny całkowitej",
    area_missing: "brak metrażu",
    price_is_not_total_offer_price: "cena nie jest całkowitą ceną oferty",
    price_is_starting_price: "cena jest ceną od",
    price_per_sqm_invalid: "nieprawidłowa cena za m²",
    district_not_confirmed: "brak potwierdzonej dzielnicy Łodzi",
    city_not_lodz: "oferta poza Łodzią",
    rental: "najem lub wynajem",
    share: "udział we współwłasności",
    commercial: "lokal użytkowy",
    plot: "działka",
    tenement_excluded: "kamienica wyłączona z próby",
    house_excluded: "dom lub segment",
    bulk_investment_ad: "zbiorcza reklama inwestycji, nie pojedynczy lokal",
    apartment_not_confirmed: "brak potwierdzenia, że to mieszkanie",
    building_type_not_confirmed: "brak potwierdzonego typu budynku",
    market_type_not_confirmed: "brak potwierdzonego rynku",
    unfinished_or_needs_renovation: "stan deweloperski lub lokal do remontu",
    renovation_exclusion: "sprzeczne dane o remoncie",
    renovation_not_confirmed_fresh_full: "brak potwierdzenia świeżego, pełnego remontu",
    turnkey_not_confirmed: "brak potwierdzenia wykończenia pod klucz",
  };
  return labels[reason] ?? reason;
}

function sourceRejectionLabel(reason: string): string {
  const labels: Record<string, string> = {
    invalid_sale_price: "nieprawidłowa całkowita cena sprzedaży",
    invalid_url: "nieprawidłowy URL",
    search_or_category_url: "link do wyszukiwania lub kategorii",
    missing_offer_id: "brak ID oferty",
    placeholder_url: "link zastępczy",
    missing_title: "brak tytułu",
    missing_price: "brak ceny",
    missing_area: "brak metrażu",
    parser_error: "błąd parsowania pojedynczego wiersza",
    duplicate: "duplikat w wynikach źródła",
    unsupported_listing: "nieobsługiwany typ ogłoszenia",
  };
  return labels[reason] ?? reason;
}

function sourceWarningLabel(warning: string): string {
  if (warning.includes("PUBLIC_SEARCH_PAGE_LIMIT_REACHED")) return "osiągnięto limit publicznych stron; dalsze strony nie zostały pobrane (zakres częściowy)";
  return warning;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "brak danych";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
