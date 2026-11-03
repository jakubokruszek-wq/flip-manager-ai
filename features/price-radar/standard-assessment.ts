import { hasCategoryBFinishEvidence, hasRadarUnfinishedWorkEvidence, inspectRadarFinishEvidence } from "./qualification";

export const RADAR_STANDARD_ASSESSMENT_VERSION = "2026-11-03.1";
export type RadarStandardAssessment = {
  version: typeof RADAR_STANDARD_ASSESSMENT_VERSION;
  category: "fresh_renovation" | "ready_high_standard" | "renovated_unknown_recency" | "needs_work" | "insufficient";
  label: string;
  reason: string;
  priority: number;
};

/** A reproducible reading of saved text, never a source-detail or operator confirmation. */
export function assessRadarSavedStandard(title: string | null, description: string | null): RadarStandardAssessment {
  const text = `${title??""}. ${description??""}`;
  const finish = inspectRadarFinishEvidence(text);
  const result = (category:RadarStandardAssessment["category"],label:string,reason:string,priority:number):RadarStandardAssessment=>({version:RADAR_STANDARD_ASSESSMENT_VERSION,category,label,reason,priority});
  // Do not infer a completed renovation from its planned finish date or from
  // other-apartment/common-area marketing. The actual qualifier independently
  // checks this again against current own-listing detail before persistence.
  if (hasRadarUnfinishedWorkEvidence(title,description)) {
    return result("needs_work","Remont wymagany lub planowany","Zapisany opis nie potwierdza zakończonych prac.",0);
  }
  if (finish.freshFullRenovation&&finish.moveInReady) return result("fresh_renovation","Opis wskazuje świeży pełny remont","Wskazano pełny, świeży remont i gotowość do zamieszkania; pozostałe dane wymagają potwierdzenia.",3);
  if (hasCategoryBFinishEvidence(title,description)) return result("ready_high_standard","Opis wskazuje gotowy wysoki standard","Wskazano zakończone wykończenie, wysoki standard i gotowość do zamieszkania; pozostałe dane wymagają potwierdzenia.",3);
  if (finish.fullRenovation&&finish.moveInReady) return result("renovated_unknown_recency","Po pełnym remoncie — brak potwierdzenia świeżości","Opis wskazuje zakończony remont i gotowość, ale nie potwierdza świeżości ani wszystkich warunków wysokiego standardu.",2);
  return result("insufficient","Za mało danych o standardzie","Brakuje jednoznacznych dowodów zakończonego remontu lub gotowego wysokiego standardu.",1);
}
