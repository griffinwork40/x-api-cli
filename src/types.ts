// ─── Config ───────────────────────────────────────────────────────────────────

/** Which authentication method the client uses on the wire. */
export type AuthMode = 'bearer' | 'oauth1' | 'oauth2';

/** The four OAuth 1.0a user-context credentials (consumer key/secret + user token/secret). */
export interface OAuth1Creds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/**
 * Configuration for {@link XClient}.
 *
 * At most one credential group is populated per client (resolved by `auth.ts`):
 * - `bearerToken`        — app-only Bearer (`X_BEARER_TOKEN`); public reads/streams.
 * - `oauth2AccessToken`  — OAuth 2.0 user access token (`X_OAUTH2_ACCESS_TOKEN`).
 *   NOTE: both `bearerToken` and `oauth2AccessToken` go in `Authorization: Bearer`,
 *   but they are DIFFERENT identities — keep them in distinct fields, never swap.
 * - `oauth1`             — OAuth 1.0a user-context creds (all 4 vars); request-signed.
 */
export interface XClientConfig {
  bearerToken?: string;
  oauth1?: OAuth1Creds;
  oauth2AccessToken?: string;
  /** Default: https://api.x.com/2 */
  baseUrl?: string;
  /** Effective auth mode; when omitted the client infers from populated creds. */
  authMode?: AuthMode;
}

// ─── Envelope ─────────────────────────────────────────────────────────────────

/** PERMISSIVE — includes shape varies per resource/expansion set. */
export interface XIncludes {
  [key: string]: unknown;
  users?: unknown[];
  tweets?: unknown[];
  media?: unknown[];
  polls?: unknown[];
  places?: unknown[];
  topics?: unknown[];
}

/** PERMISSIVE — meta shape varies per endpoint (mirrors HunterMeta). */
export interface XMeta {
  [key: string]: unknown;
  result_count?: number;
  next_token?: string;
  previous_token?: string;
  newest_id?: string;
  oldest_id?: string;
  total_tweet_count?: number;
}

/** Rate-limit signal captured from response headers on every request. */
export interface XRateLimit {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}

/**
 * A single partial error — present in `errors[]` alongside `data` even on HTTP 200
 * (e.g. one of several requested ids was deleted/suspended/not-authorized).
 */
export interface XPartialError {
  [key: string]: unknown;
  title?: string;
  detail?: string;
  type?: string;
  resource_type?: string;
  parameter?: string;
  value?: string;
  resource_id?: string;
}

/**
 * The full X API v2 response envelope.
 *
 * The client returns THIS object (never an unwrapped `data`) so partial `errors[]`
 * on a 200 are never silently dropped — see the contract at the top of `client.ts`.
 */
export interface XEnvelope<T> {
  data?: T;
  includes?: XIncludes;
  meta?: XMeta;
  errors?: XPartialError[];
}

// ─── Error class (thrown by the client on request-level failures) ───────────────

/**
 * Thrown by {@link XClient} when a request fails at the HTTP level.
 *
 * Carries both error shapes the X API emits:
 *  - RFC 7807 Problem  → `title`, `detail`, `type` (the namespaced problem-type URI).
 *  - Legacy `{errors:[{code,message}]}` → `code` (numeric).
 * Plus `partialErrors` when the failure body carried an `errors[]` array.
 *
 * `cli.ts` catches this in its top-level handler and maps it to exit code 1.
 * (Defined here — NOT in errors.ts — so both the client and the CLI import one class.)
 */
export class XApiError extends Error {
  readonly status: number;
  readonly title?: string;
  readonly detail?: string;
  /** The RFC 7807 problem-type URI, e.g. `https://api.twitter.com/2/problems/unsupported-authentication`. */
  readonly type?: string;
  /** Legacy numeric error code (from `{errors:[{code,message}]}`). */
  readonly code?: number;
  readonly partialErrors?: XPartialError[];

  constructor(
    message: string,
    status: number,
    opts: {
      title?: string;
      detail?: string;
      type?: string;
      code?: number;
      partialErrors?: XPartialError[];
    } = {},
  ) {
    // Build a readable message from title+detail when the caller passed a bare fallback.
    const composed =
      message && message.length > 0
        ? message
        : opts.title && opts.detail
          ? `${opts.title}: ${opts.detail}`
          : (opts.title ?? opts.detail ?? `HTTP ${status}`);
    super(composed);
    this.name = 'XApiError';
    this.status = status;
    this.title = opts.title;
    this.detail = opts.detail;
    this.type = opts.type;
    this.code = opts.code;
    this.partialErrors = opts.partialErrors;
  }

  /**
   * Returns the last path segment of the RFC 7807 `type` URI for CLI special-casing,
   * e.g. `.../problems/unsupported-authentication` → `unsupported-authentication`.
   * Returns `undefined` when no `type` is set.
   */
  problemTypeSuffix(): string | undefined {
    if (!this.type) return undefined;
    const trimmed = this.type.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }
}

// ─── Response resource types (PERMISSIVE — index signature + documented fields) ─
// The CLI prints JSON; it does not need exhaustive typing. Keep these loose.

export interface Tweet {
  [key: string]: unknown;
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  edit_history_tweet_ids?: string[];
  public_metrics?: Record<string, number>;
}

export interface User {
  [key: string]: unknown;
  id?: string;
  name?: string;
  username?: string;
  verified?: boolean;
}

export interface MediaUploadResult {
  [key: string]: unknown;
  id?: string;
  media_key?: string;
  processing_info?: Record<string, unknown>;
  expires_after_secs?: number;
}

export interface XList {
  [key: string]: unknown;
  id?: string;
  name?: string;
  description?: string;
  private?: boolean;
}

export interface Space {
  [key: string]: unknown;
  id?: string;
  state?: string;
  title?: string;
  creator_id?: string;
}

export interface DmResult {
  [key: string]: unknown;
  dm_conversation_id?: string;
  dm_event_id?: string;
}
