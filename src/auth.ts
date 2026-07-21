import type { AuthMode, XClientConfig } from './types.js';
import { MissingCredentialsError } from './errors.js';
import { XClient } from './client.js';

/**
 * Auth resolution — turns the environment + a capability request into a configured
 * {@link XClient}. `resolveConfig` is PURE (env is injected, never read from
 * `process.env` directly) so it is fully unit-testable.
 *
 * Env vars (canonical set, doc 00 §"Recommended env var names"):
 *   X_BEARER_TOKEN                                        → app-only Bearer (reads/streams)
 *   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN /
 *     X_ACCESS_TOKEN_SECRET                               → OAuth 1.0a user context
 *   X_OAUTH2_ACCESS_TOKEN                                 → OAuth 2.0 user context
 *   X_API_BASE_URL (optional)                             → base URL override
 *
 * ─── LOCKED ORCHESTRATOR DECISION #1 — write auth tie-break ─────────────────────
 * For write / user-context actions, when BOTH OAuth 1.0a (all 4 vars) AND an OAuth 2.0
 * user token are present, we PREFER OAuth 1.0a. Rationale: OAuth1 console tokens do not
 * expire or need refreshing, which is more robust for a long-lived CLI. OAuth2 is used
 * only when OAuth1's 4 vars are absent. (This overrides the PLAN §2 "prefer oauth2"
 * default note — the orchestrator settled on oauth1-preferred.)
 */

export interface ResolveOpts {
  /** Force a specific mode (`--auth`). Errors if that mode's creds are absent. */
  authMode?: AuthMode;
  /** The action mutates user state (post/like/follow/…): requires a user context. */
  needsWrite?: boolean;
  /**
   * A user-context *read* (users/me, home timeline, liking-users, liked-tweets):
   * requires a USER token (OAuth 1.0a preferred, else OAuth 2.0) and REJECTS app-only
   * Bearer. Same credential requirement as {@link ResolveOpts.needsWrite}, but named
   * distinctly because the action reads on behalf of the user rather than mutating.
   */
  needsUser?: boolean;
  /** Bookmarks: OAuth 2.0 user token ONLY. */
  needsBookmark?: boolean;
  /** Streams / full-archive search & counts: app-only Bearer ONLY. */
  needsStream?: boolean;
}

interface Creds {
  bearer?: string;
  oauth2?: string;
  oauth1?: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  };
  baseUrl?: string;
  /** Which oauth1 vars are missing (for error messages when partially set). */
  oauth1Missing: string[];
}

function readCreds(env: NodeJS.ProcessEnv): Creds {
  const apiKey = env['X_API_KEY'];
  const apiSecret = env['X_API_SECRET'];
  const accessToken = env['X_ACCESS_TOKEN'];
  const accessTokenSecret = env['X_ACCESS_TOKEN_SECRET'];

  const oauth1Missing: string[] = [];
  if (!apiKey) oauth1Missing.push('X_API_KEY');
  if (!apiSecret) oauth1Missing.push('X_API_SECRET');
  if (!accessToken) oauth1Missing.push('X_ACCESS_TOKEN');
  if (!accessTokenSecret) oauth1Missing.push('X_ACCESS_TOKEN_SECRET');

  const oauth1Complete = oauth1Missing.length === 0;

  return {
    bearer: env['X_BEARER_TOKEN'] || undefined,
    oauth2: env['X_OAUTH2_ACCESS_TOKEN'] || undefined,
    oauth1: oauth1Complete
      ? {
          apiKey: apiKey as string,
          apiSecret: apiSecret as string,
          accessToken: accessToken as string,
          accessTokenSecret: accessTokenSecret as string,
        }
      : undefined,
    baseUrl: env['X_API_BASE_URL'] || undefined,
    oauth1Missing,
  };
}

/** Builds a config for a resolved mode, populating only that mode's creds. */
function configFor(mode: AuthMode, c: Creds): XClientConfig {
  const base: XClientConfig = { authMode: mode };
  if (c.baseUrl) base.baseUrl = c.baseUrl;
  if (mode === 'bearer') base.bearerToken = c.bearer;
  else if (mode === 'oauth2') base.oauth2AccessToken = c.oauth2;
  else if (mode === 'oauth1') base.oauth1 = c.oauth1;
  return base;
}

/**
 * Resolves an {@link XClientConfig} from the environment + capability request.
 * Throws {@link MissingCredentialsError} (a UsageError → exit 1) naming the exact env
 * vars required when the needed credentials are absent.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, opts: ResolveOpts): XClientConfig {
  const c = readCreds(env);

  // ── Forced mode via --auth ──────────────────────────────────────────────────────
  if (opts.authMode) {
    switch (opts.authMode) {
      case 'bearer':
        if (!c.bearer) {
          throw new MissingCredentialsError(
            "--auth bearer requires X_BEARER_TOKEN (app-only Bearer token).",
          );
        }
        return configFor('bearer', c);
      case 'oauth1':
        if (!c.oauth1) {
          throw new MissingCredentialsError(
            `--auth oauth1 requires all four OAuth 1.0a vars; missing: ${c.oauth1Missing.join(', ')}.`,
          );
        }
        return configFor('oauth1', c);
      case 'oauth2':
        if (!c.oauth2) {
          throw new MissingCredentialsError(
            '--auth oauth2 requires X_OAUTH2_ACCESS_TOKEN (OAuth 2.0 user access token).',
          );
        }
        return configFor('oauth2', c);
    }
  }

  // ── Bookmarks: OAuth 2.0 user token ONLY ─────────────────────────────────────────
  if (opts.needsBookmark) {
    if (c.oauth2) return configFor('oauth2', c);
    throw new MissingCredentialsError(
      'Bookmarks require an OAuth 2.0 user token: set X_OAUTH2_ACCESS_TOKEN ' +
        '(OAuth 1.0a and app-only Bearer are not accepted for bookmarks).',
    );
  }

  // ── Streams / full-archive: app-only Bearer ONLY ─────────────────────────────────
  if (opts.needsStream) {
    if (c.bearer) return configFor('bearer', c);
    throw new MissingCredentialsError(
      'Streaming / full-archive endpoints require an app-only Bearer token: set X_BEARER_TOKEN ' +
        '(user-context tokens are not accepted here).',
    );
  }

  // ── Writes: user context; LOCKED DECISION #1 → prefer OAuth1 when both present ────
  if (opts.needsWrite) {
    if (c.oauth1) return configFor('oauth1', c); // prefer oauth1
    if (c.oauth2) return configFor('oauth2', c);
    throw new MissingCredentialsError(
      'This write action needs a user context. Provide EITHER all four OAuth 1.0a vars ' +
        '(X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) OR an OAuth 2.0 ' +
        'user token (X_OAUTH2_ACCESS_TOKEN). App-only Bearer (X_BEARER_TOKEN) is rejected for writes.',
    );
  }

  // ── User-context reads: user token required (prefer OAuth1); app-only Bearer rejected ─
  // Same credential requirement as writes, but framed as a read (users/me, home timeline,
  // liking-users, liked-tweets) — these endpoints resolve "the authenticated user".
  if (opts.needsUser) {
    if (c.oauth1) return configFor('oauth1', c); // prefer oauth1 (locked decision #1)
    if (c.oauth2) return configFor('oauth2', c);
    throw new MissingCredentialsError(
      'This action reads on behalf of the authenticated user and needs a user context. ' +
        'Provide EITHER all four OAuth 1.0a vars (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, ' +
        'X_ACCESS_TOKEN_SECRET) OR an OAuth 2.0 user token (X_OAUTH2_ACCESS_TOKEN). ' +
        'App-only Bearer (X_BEARER_TOKEN) is rejected here.',
    );
  }

  // ── Reads: prefer Bearer, else any user token (oauth1 tie-break over oauth2) ──────
  if (c.bearer) return configFor('bearer', c);
  if (c.oauth1) return configFor('oauth1', c);
  if (c.oauth2) return configFor('oauth2', c);

  throw new MissingCredentialsError(
    'No credentials found. Set X_BEARER_TOKEN (app-only reads), OR an OAuth 2.0 user token ' +
      '(X_OAUTH2_ACCESS_TOKEN), OR all four OAuth 1.0a vars (X_API_KEY, X_API_SECRET, ' +
      'X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET).',
  );
}

/**
 * Convenience: `new XClient(resolveConfig(env, opts))`.
 */
export function makeClient(env: NodeJS.ProcessEnv, opts: ResolveOpts): XClient {
  return new XClient(resolveConfig(env, opts));
}
