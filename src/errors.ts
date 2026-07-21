/**
 * CLI-level error types.
 *
 * Command modules and `auth.ts` throw these for input/flow problems instead of
 * calling `process.exit` directly — that keeps those functions pure and unit-testable.
 * `cli.ts` owns the single top-level catch that maps each error to an exit code:
 *   - UsageError             -> exit 1  (bad/missing flags or positionals)
 *   - MissingCredentialsError -> exit 1  (subclass of UsageError; auth resolution failed)
 *   - XApiError              -> exit 1  (defined in ./types.ts, thrown by the client)
 *   - RateLimitError         -> exit 3  (thrown by the client on HTTP 429)
 *   - anything else          -> exit 1
 */

/** Thrown when required flags/positionals are missing or invalid. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Thrown when auth resolution cannot find the credentials a capability needs.
 * A subclass of {@link UsageError} so a single `instanceof UsageError` catch covers
 * both (same exit code 1). The message names the exact env vars required.
 */
export class MissingCredentialsError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Thrown by the client on HTTP 429 (Too Many Requests).
 * Carries `resetInSeconds` (computed from `x-rate-limit-reset` or `Retry-After`)
 * so the CLI can tell the user how long to back off. Maps to exit code 3.
 */
export class RateLimitError extends Error {
  readonly resetInSeconds: number;

  constructor(resetInSeconds: number, message?: string) {
    super(message ?? `Rate limited — retry in ${resetInSeconds}s`);
    this.name = 'RateLimitError';
    this.resetInSeconds = resetInSeconds;
  }
}
