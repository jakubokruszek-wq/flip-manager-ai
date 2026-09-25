import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { maxDuration, POST as generate } from "./generate/route";

export { maxDuration };

// Backward-compatible alias; the UI uses /generate.
export async function POST(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  return generate(request);
}
