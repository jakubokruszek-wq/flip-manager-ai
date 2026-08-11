import type { FacebookFailureCode } from "../../../features/facebook-worker/types.ts";

export class ControlledFacebookFailure extends Error {
  constructor(public readonly code: FacebookFailureCode, message: string) { super(message); this.name = "ControlledFacebookFailure"; }
}

