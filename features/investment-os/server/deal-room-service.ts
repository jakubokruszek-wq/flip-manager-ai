import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDealBrain } from "../brain";
import { affectedDirectors, answerOverrides, mergeAnswers, parseAnswerCommand, preserveUnchangedDirectors, type DealRoomState } from "../deal-room-answers";
import { fingerprint } from "../engine";
import { InvestmentDealVersionConflict } from "./deal-cas";
import { prepareInvestmentDeal, readStoredDeal, toDealRow } from "./deal-service";
import type { DealFactOverrides } from "../types";

export function dealRoomEnabled(): boolean { return process.env.DEAL_ROOM_QA_ENABLED === "true"; }
export class DealRoomNotFound extends Error {}
export async function readDealRoom(listingId: string, actorId: string): Promise<DealRoomState | null> {
  const db = createAdminClient(), stored = await readStoredDeal(db, listingId);
  if (!stored) return null;
  const { data, error } = await db.from("deal_room_workspaces").select("owner_id,state").eq("deal_id", stored.deal.id).maybeSingle();
  if (error) throw error;
  if (data && data.owner_id !== actorId) throw new DealRoomNotFound();
  const { data: overrides, error: overridesError } = await db.from("deal_fact_overrides").select("values").eq("deal_id", stored.deal.id).maybeSingle();
  if (overridesError) throw overridesError;
  const state = data?.state as Omit<DealRoomState, "version"> | undefined;
  return { answers: state?.answers ?? {}, baselineOverrides: state?.baselineOverrides ?? (overrides?.values ?? {}) as DealFactOverrides, rounds: state?.rounds ?? [], version: stored.version };
}
export async function assertDealRoomOwner(listingId: string, actorId: string): Promise<void> {
  if (dealRoomEnabled()) await readDealRoom(listingId, actorId);
}
export async function saveDealRoomAnswers(listingId: string, actorId: string, raw: unknown) {
  const command = parseAnswerCommand(raw), db = createAdminClient();
  const stored = await readStoredDeal(db, listingId);
  if (!stored) throw new DealRoomNotFound();
  const state = await readDealRoom(listingId, actorId);
  if (!state) throw new DealRoomNotFound();
  const payloadHash = fingerprint(command);
  const { data: replay, error: replayError } = await db.from("deal_room_rounds").select("payload_hash,response").eq("deal_id", stored.deal.id).eq("owner_id", actorId).eq("request_id", command.requestId).maybeSingle();
  if (replayError) throw replayError;
  if (replay) { if (replay.payload_hash !== payloadHash) throw new InvestmentDealVersionConflict(); return replay.response; }
  if (command.expectedVersion !== stored.version || state.version !== stored.version) throw new InvestmentDealVersionConflict();
  const now = new Date().toISOString();
  const answers = mergeAnswers(stored.deal, state, command, actorId, now);
  const values = answerOverrides(stored.deal, state.baselineOverrides, answers);
  const prepared = await prepareInvestmentDeal(db, listingId, values);
  if (!prepared.value || prepared.expectedVersion !== stored.version) throw new InvestmentDealVersionConflict();
  const deal = preserveUnchangedDirectors(stored.deal, prepared.value);
  const changedFields = command.answers.map((a) => a.field), invalidated = affectedDirectors(changedFields);
  const round = { requestId: command.requestId, savedAt: now, actorId, changedFields, invalidated, before: buildDealBrain(stored.deal), after: buildDealBrain(deal) };
  // Complete immutable rounds live in the ledger; the current projection retains the previous/latest comparison only.
  const next = { answers, baselineOverrides: state.baselineOverrides, rounds: [round] };
  const response = { ok: true, deal, room: { ...next, version: stored.version + 1 }, invalidated };
  const { data, error } = await db.rpc("commit_deal_room_round_cas", { p_deal: toDealRow(deal), p_expected_version: stored.version, p_source_updated_at: prepared.sourceUpdatedAt, p_owner_id: actorId, p_request_id: command.requestId, p_payload_hash: payloadHash, p_values: values, p_state: next, p_response: response });
  if (error) { if (error.message.includes("INVESTMENT_DEAL_VERSION_CONFLICT")) throw new InvestmentDealVersionConflict(); if (error.message.includes("DEAL_ROOM_NOT_FOUND")) throw new DealRoomNotFound(); throw error; }
  return data;
}
