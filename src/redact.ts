import { formatJson } from './utils.js';
import type { XClientConfig } from './types.js';

/**
 * Replaces ALL occurrences of every secret in `str` with `'[REDACTED]'`.
 *
 * Generalizes the reference `redactKey` (single key) to the full credential set an
 * X client can hold (bearer, api key/secret, access token/secret, oauth2 token).
 * - Secrets that are undefined/empty or shorter than 4 characters are skipped
 *   (too short to be a meaningful secret; would over-redact common substrings).
 * - Regex-special characters in each secret are escaped so it matches literally.
 */
export function redactSecrets(str: string, secrets: (string | undefined)[]): string {
  let result = str;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }
  return result;
}

/**
 * JSON-stringifies `data` with 2-space indentation, then redacts all secrets from
 * the resulting string. Commands print with `safeStringify(result, collectSecrets(cfg))`.
 */
export function safeStringify(data: unknown, secrets: (string | undefined)[]): string {
  return redactSecrets(formatJson(data), secrets);
}

/**
 * Gathers every credential the client config holds so commands can redact ALL of
 * them uniformly: `safeStringify(result, collectSecrets(cfg))`.
 * Only populated fields are returned.
 */
export function collectSecrets(cfg: XClientConfig): string[] {
  const secrets: string[] = [];
  if (cfg.bearerToken) secrets.push(cfg.bearerToken);
  if (cfg.oauth2AccessToken) secrets.push(cfg.oauth2AccessToken);
  if (cfg.oauth1) {
    secrets.push(
      cfg.oauth1.apiKey,
      cfg.oauth1.apiSecret,
      cfg.oauth1.accessToken,
      cfg.oauth1.accessTokenSecret,
    );
  }
  return secrets.filter((s): s is string => Boolean(s));
}
