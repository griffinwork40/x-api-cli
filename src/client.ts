import type {
  XClientConfig,
  XEnvelope,
  XMeta,
  XRateLimit,
  XPartialError,
  AuthMode,
} from './types.js';
import { XApiError } from './types.js';
import { RateLimitError } from './errors.js';
import { buildQueryParams } from './utils.js';
import { buildOAuth1Header } from './oauth1.js';
import { redactSecrets, collectSecrets } from './redact.js';

/**
 * XClient — a thin `fetch` wrapper for the X API v2.
 *
 * ─── RETURN-SHAPE CONTRACT (locked orchestrator decision #2) ────────────────────
 * `get`/`post`/`put`/`delete` return the FULL parsed envelope object
 *   `{ data?, includes?, meta?, errors? }`
 * — NOT an unwrapped `data`. This is deliberate: X emits partial `errors[]` even on
 * HTTP 200 (e.g. one of several requested ids was deleted/suspended), and unwrapping
 * `data` would silently drop them. Commands decide what to print from the envelope,
 * so partial errors always stay visible. (`204 No Content` returns `null`.)
 *
 * The client also populates:
 *   • `lastMeta`      — `json.meta` from the most recent 2xx (or `null`).
 *   • `lastRateLimit` — the `x-rate-limit-*` / `Retry-After` headers from every response.
 *
 * ─── AUTH ────────────────────────────────────────────────────────────────────────
 * Effective mode is `cfg.authMode` when set, else inferred from the populated creds
 * (oauth1 → oauth2 → bearer). Header rules:
 *   • bearer / oauth2 → `Authorization: Bearer <token>` (both are just a token string;
 *     they are DIFFERENT identities — the config keeps them in separate fields).
 *   • oauth1          → `Authorization: <OAuth …>` via `buildOAuth1Header`. Only
 *     `application/x-www-form-urlencoded` body params participate in the signature;
 *     JSON *and multipart* bodies are signed with QUERY params only (X's OAuth1-over-v2
 *     behavior). See `postMultipart` for the media-upload path (Wave C addition).
 *
 * ─── ERRORS ───────────────────────────────────────────────────────────────────────
 * `handleResponse` throws:
 *   • `RateLimitError` on HTTP 429 (with `resetInSeconds`).
 *   • `XApiError` on any other `!res.ok`, parsing BOTH the RFC 7807 Problem shape
 *     (`{type,title,detail,status}`) and the legacy `{errors:[{code,message}]}` shape.
 * Secrets are redacted from every thrown error message.
 */
export class XClient {
  private readonly baseUrl: string;
  private readonly config: XClientConfig;
  private readonly authMode: AuthMode;
  private readonly secrets: string[];

  public lastMeta: XMeta | null = null;
  public lastRateLimit: XRateLimit | null = null;
  /** Partial `errors[]` from the most recent 2xx response (also present on the envelope). */
  public lastPartialErrors: XPartialError[] | null = null;

  constructor(config: XClientConfig) {
    this.config = config;
    this.baseUrl = (config.baseUrl ?? 'https://api.x.com/2').replace(/\/$/, '');
    this.authMode = config.authMode ?? this.inferAuthMode(config);
    this.secrets = collectSecrets(config);
  }

  private inferAuthMode(cfg: XClientConfig): AuthMode {
    if (cfg.oauth1) return 'oauth1';
    if (cfg.oauth2AccessToken) return 'oauth2';
    return 'bearer';
  }

  // ─── Public HTTP methods ──────────────────────────────────────────────────────

  async get<T = XEnvelope<unknown>>(
    path: string,
    params?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    const queryParams = buildQueryParams(params ?? {});
    const queryString = new URLSearchParams(queryParams).toString();
    const url = `${this.baseUrl}${path}${queryString ? '?' + queryString : ''}`;

    const headers = this.authHeaders('GET', url, queryParams);
    headers['Accept'] = 'application/json';

    const response = await fetch(url, { method: 'GET', headers });
    return this.handleResponse<T>(response);
  }

  async post<T = XEnvelope<unknown>>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return this.writeJson<T>('POST', path, body);
  }

  async put<T = XEnvelope<unknown>>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return this.writeJson<T>('PUT', path, body);
  }

  async delete<T = XEnvelope<unknown>>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.authHeaders('DELETE', url, {});
    const init: RequestInit = { method: 'DELETE', headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    return this.handleResponse<T>(response);
  }

  /** Shared JSON write for POST/PUT (and DELETE-with-body via `delete`). */
  private async writeJson<T>(
    method: 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // JSON bodies are NOT part of the OAuth1 signature — sign with query params only.
    const headers = this.authHeaders(method, url, {});
    headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body ?? {}),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * POST a `multipart/form-data` body (used by `media upload` one-shot + chunked APPEND).
   *
   * ─── WAVE C ADDITION (documented per Wave C brief Task 2) ────────────────────────
   * Added in Wave C for the genuine media-upload integration need: the real X API
   * requires `multipart/form-data` for media bytes (a base64-in-JSON body would 4xx).
   *
   * Contract:
   *   • Node's global `FormData`/`Blob` (Node ≥18) — the caller builds the `FormData`
   *     (`media` = a `Blob` of the file bytes/chunk, plus `media_category`/`segment_index`).
   *   • **`Content-Type` is NOT set here** — `fetch` derives it from the `FormData` body,
   *     including the multipart boundary. Setting it manually would break the boundary.
   *   • OAuth1: multipart bodies do NOT participate in the signature (same rule as JSON
   *     POSTs) — we sign with QUERY params only, passing empty `bodyParams` to
   *     `authHeaders`. `queryParams` (if any) still feed the signature.
   */
  async postMultipart<T = XEnvelope<unknown>>(
    path: string,
    form: FormData,
    queryParams?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    const qp = buildQueryParams(queryParams ?? {});
    const queryString = new URLSearchParams(qp).toString();
    const url = `${this.baseUrl}${path}${queryString ? '?' + queryString : ''}`;

    // Sign query params only (empty bodyParams: multipart does not sign the body).
    const headers = this.authHeaders('POST', url, qp);
    headers['Accept'] = 'application/json';
    // Deliberately DO NOT set Content-Type — fetch sets the multipart boundary.

    const response = await fetch(url, { method: 'POST', headers, body: form });
    return this.handleResponse<T>(response);
  }

  // ─── Auth header construction ───────────────────────────────────────────────────

  /**
   * Builds the request headers for `method`+`url`.
   * `queryParams` / `bodyParams` feed the OAuth1 signature (bodyParams only for
   * form-urlencoded/multipart requests — JSON callers pass `{}`).
   */
  private authHeaders(
    method: string,
    url: string,
    queryParams: Record<string, string>,
    bodyParams: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.authMode === 'oauth1') {
      const o = this.config.oauth1;
      if (!o) throw new Error('oauth1 mode selected but no oauth1 credentials present');
      headers['Authorization'] = buildOAuth1Header({
        method,
        url,
        queryParams,
        bodyParams,
        consumerKey: o.apiKey,
        consumerSecret: o.apiSecret,
        token: o.accessToken,
        tokenSecret: o.accessTokenSecret,
      });
    } else if (this.authMode === 'oauth2') {
      headers['Authorization'] = `Bearer ${this.config.oauth2AccessToken ?? ''}`;
    } else {
      // bearer
      headers['Authorization'] = `Bearer ${this.config.bearerToken ?? ''}`;
    }

    return headers;
  }

  // ─── Response handling ──────────────────────────────────────────────────────────

  private async handleResponse<T>(res: Response): Promise<T> {
    // 1. Capture rate-limit headers on EVERY response (tolerate missing).
    this.lastRateLimit = this.captureRateLimit(res);

    // 2. HTTP 429 → RateLimitError (compute backoff from reset or Retry-After).
    if (res.status === 429) {
      const resetInSeconds = this.computeResetSeconds();
      throw new RateLimitError(resetInSeconds);
    }

    // 3. 204 No Content — nothing to parse.
    if (res.status === 204) {
      this.lastPartialErrors = null;
      return null as T;
    }

    // 4. Parse JSON (tolerate a non-JSON body).
    const json = (await res.json().catch(() => null)) as XEnvelope<T> | null;

    // 5. Error responses.
    if (!res.ok) {
      throw this.buildApiError(res, json);
    }

    // 6. 2xx: stash meta + partial errors, return the FULL envelope (locked decision #2).
    this.lastMeta = json?.meta ?? null;
    this.lastPartialErrors =
      json?.errors && json.errors.length > 0 ? json.errors : null;
    return (json ?? {}) as T;
  }

  private captureRateLimit(res: Response): XRateLimit {
    const num = (name: string): number | undefined => {
      const raw = res.headers.get(name);
      if (raw === null) return undefined;
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? undefined : n;
    };
    return {
      limit: num('x-rate-limit-limit'),
      remaining: num('x-rate-limit-remaining'),
      reset: num('x-rate-limit-reset'),
      retryAfter: num('retry-after'),
    };
  }

  private computeResetSeconds(): number {
    const rl = this.lastRateLimit;
    if (rl?.reset !== undefined) {
      const nowSec = Math.floor(Date.now() / 1000);
      return Math.max(0, rl.reset - nowSec);
    }
    if (rl?.retryAfter !== undefined) {
      return Math.max(0, rl.retryAfter);
    }
    return 0;
  }

  /** Detects the error shape (RFC 7807 vs legacy) and builds a redacted XApiError. */
  private buildApiError(res: Response, json: XEnvelope<unknown> | null): XApiError {
    const status = res.status;
    const redact = (s: string): string => redactSecrets(s, this.secrets);

    // Shape A: RFC 7807 Problem — top-level type/title.
    const body = json as Record<string, unknown> | null;
    if (body && (typeof body['type'] === 'string' || typeof body['title'] === 'string')) {
      const title = typeof body['title'] === 'string' ? body['title'] : undefined;
      const detail = typeof body['detail'] === 'string' ? body['detail'] : undefined;
      const type = typeof body['type'] === 'string' ? body['type'] : undefined;
      const msg = redact(
        title && detail ? `${title}: ${detail}` : (title ?? detail ?? `HTTP ${status}`),
      );
      return new XApiError(msg, status, {
        title: title ? redact(title) : undefined,
        detail: detail ? redact(detail) : undefined,
        type,
      });
    }

    // Shape B: legacy / partial `errors:[{code?,message?|title?,detail?}]`.
    const errors = json?.errors;
    const first = errors && errors.length > 0 ? (errors[0] as Record<string, unknown>) : undefined;
    if (first) {
      const code = typeof first['code'] === 'number' ? first['code'] : undefined;
      const message =
        typeof first['message'] === 'string'
          ? first['message']
          : typeof first['title'] === 'string'
            ? first['title']
            : `HTTP ${status}`;
      const type = typeof first['type'] === 'string' ? first['type'] : undefined;
      const detail = typeof first['detail'] === 'string' ? first['detail'] : undefined;
      return new XApiError(redact(message), status, {
        code,
        type,
        detail: detail ? redact(detail) : undefined,
        partialErrors: errors as XPartialError[],
      });
    }

    // Shape C: nothing parseable — generic HTTP status line.
    return new XApiError(redact(`HTTP ${status} ${res.statusText}`), status);
  }
}
