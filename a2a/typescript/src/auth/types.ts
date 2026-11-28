import type { Identity } from "apcore-js";

export interface Authenticator {
  authenticate(headers: Record<string, string>): Identity | null;
  /** Reject a provided credential that did not authenticate even in permissive mode. */
  readonly rejectInvalidCredentials?: boolean;
  securitySchemes(): Record<string, unknown>;
}
