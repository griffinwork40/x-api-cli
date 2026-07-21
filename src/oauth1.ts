import { createHmac, randomBytes } from 'node:crypto';

/**
 * OAuth 1.0a request signing (RFC 5849 §3.4), HMAC-SHA1.
 *
 * Hand-rolled with Node's `node:crypto` (no `oauth`/`crypto-js` deps). Every internal
 * step is a small pure exported function so it is independently unit-testable, and the
 * whole signer is pinned against X's canonical "Creating a signature" example vector in
 * `oauth1.test.ts` — verified live against docs.x.com (api.twitter.com host →
 * `hCtSmYh+iHYCEqBWrE7C7hYmtUk=`; current api.x.com host → `Ls93hJiZbQ3akF3HF3x1Bz8/zU4=`).
 *
 * The signature base string and signing key are the two most error-prone pieces; the
 * percent-encoder (`percentEncode`) is the #1 source of signature bugs and is unit-tested
 * against the RFC 3986 unreserved-character set.
 */

/**
 * RFC 3986 percent-encoding for OAuth.
 *
 * Encodes everything except the unreserved set `A-Z a-z 0-9 - . _ ~`.
 * `encodeURIComponent` already:
 *   - encodes space as `%20` (not `+`), `+` as `%2B`, `,` as `%2C`
 *   - leaves `- . _ ~` unescaped
 * …but it does NOT escape `! * ' ( )`, which RFC 3986 (and OAuth) require, so we escape
 * those four→five manually. Result: `space→%20`, `!→%21`, `*→%2A`, `'→%27`, `(→%28`,
 * `)→%29`, `~` stays `~`.
 */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Merges the oauth_* params, request query params, and form-body params into the
 * single normalized parameter string used in the signature base string:
 *   1. percent-encode every key AND value,
 *   2. sort by encoded key (then by encoded value for ties),
 *   3. join as `k=v&k=v`.
 * (RFC 5849 §3.4.1.3.2.)
 */
export function collectSignatureParams(
  oauthParams: Record<string, string>,
  queryParams: Record<string, string> = {},
  bodyParams: Record<string, string> = {},
): string {
  const merged: Record<string, string> = {
    ...queryParams,
    ...bodyParams,
    ...oauthParams,
  };

  const encoded: Array<[string, string]> = Object.entries(merged).map(([k, v]) => [
    percentEncode(k),
    percentEncode(v),
  ]);

  encoded.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    // tie-break on encoded value
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  return encoded.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Builds the signature base string: `METHOD & pct(baseUrl) & pct(paramString)`.
 * `baseUrl` is scheme+host+path only — the query string MUST be excluded (its params
 * are already folded into `paramString`). Method is upper-cased. (RFC 5849 §3.4.1.1.)
 */
export function buildSignatureBaseString(
  method: string,
  baseUrl: string,
  paramString: string,
): string {
  return [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString),
  ].join('&');
}

/**
 * Builds the HMAC signing key: `pct(consumerSecret) & pct(tokenSecret)`.
 * (RFC 5849 §3.4.2. The `&` is always present even when the token secret is empty.)
 */
export function buildSigningKey(consumerSecret: string, tokenSecret: string): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

/**
 * Computes the base64 HMAC-SHA1 of `baseString` under `signingKey`. (RFC 5849 §3.4.2.)
 */
export function sign(baseString: string, signingKey: string): string {
  return createHmac('sha1', signingKey).update(baseString).digest('base64');
}

/**
 * Assembles the `Authorization: OAuth …` header value from the oauth_* params + the
 * computed signature. Each param is emitted as `key="percentEncode(value)"`, comma-
 * separated. `oauth_signature` is included and percent-encoded (so `=` and `+` in the
 * base64 become `%3D`/`%2B`).
 */
export function buildHeader(
  oauthParams: Record<string, string>,
  signature: string,
): string {
  const all: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const parts = Object.keys(all)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(all[key] as string)}"`);
  return 'OAuth ' + parts.join(', ');
}

// ─── Base URL normalization ─────────────────────────────────────────────────────

/**
 * Strips the query string and fragment from `url` so the signature base string uses
 * scheme+host+path only (RFC 5849 §3.4.1.2). Query params are signed via `queryParams`.
 */
function stripQuery(url: string): string {
  const qIdx = url.indexOf('?');
  const base = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const hIdx = base.indexOf('#');
  return hIdx >= 0 ? base.slice(0, hIdx) : base;
}

/**
 * Builds the full `Authorization: OAuth …` header value for a request.
 *
 * `oauthTimestamp` / `oauthNonce` are injectable so tests are deterministic; in
 * production they default to the current unix seconds and a random hex nonce.
 *
 * Only form-urlencoded `bodyParams` participate in the signature — JSON bodies are
 * NOT signed (the client passes `bodyParams` only for `application/x-www-form-urlencoded`
 * and multipart requests; see `client.ts`).
 */
export function buildOAuth1Header(params: {
  method: string;
  url: string;
  queryParams?: Record<string, string>;
  bodyParams?: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  oauthTimestamp?: string;
  oauthNonce?: string;
}): string {
  const timestamp = params.oauthTimestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = params.oauthNonce ?? randomBytes(16).toString('hex');

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: params.token,
    oauth_version: '1.0',
  };

  const paramString = collectSignatureParams(
    oauthParams,
    params.queryParams ?? {},
    params.bodyParams ?? {},
  );
  const baseUrl = stripQuery(params.url);
  const baseString = buildSignatureBaseString(params.method, baseUrl, paramString);
  const signingKey = buildSigningKey(params.consumerSecret, params.tokenSecret);
  const signature = sign(baseString, signingKey);

  return buildHeader(oauthParams, signature);
}
