/** sync_runs.error_code values from the path F contract. Null means the run succeeded. */
export const ERROR_CODES = [
  "auth_expired",
  "pass_token_invalid",
  "upstream_5xx",
  "upstream_timeout",
  "parse_error",
  "rate_limited",
  "incomplete_page",
  "unknown",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
