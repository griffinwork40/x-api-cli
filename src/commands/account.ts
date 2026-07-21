import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import { addFieldFlags, collectFieldParams } from '../utils.js';
import type { XClientConfig } from '../types.js';

export const ACCOUNT_HELP = `x account <whoami|rate-limit> [flags]
  whoami       GET /2/users/me — the authenticated user (user context only). [default]
                 --user-fields <csv>, --expansions <csv>
  rate-limit   Does a cheap read, then prints the captured x-rate-limit-* headers.
                 --username <handle>  (probe GET /2/users/by/username/{h} under Bearer)`;

/**
 * account — the cheap "does my auth work + how much quota" smoke command.
 * (Also the canonical example other command modules copy.)
 *
 *   whoami      — GET /2/users/me           (user context only; default sub-action)
 *   rate-limit  — cheap read + print `client.lastRateLimit`
 *
 * Dispatch on args[0]; an empty sub-action defaults to `whoami` (so `x account`
 * with no args behaves like `x account whoami`, mirroring the reference simplicity).
 */
export async function runAccount(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    // Default sub-action: no arg (or an explicit `whoami`) → whoami.
    case undefined:
    case 'whoami':
      return whoami(client, rest, cfg);
    case 'rate-limit':
      return rateLimit(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub}'. ${ACCOUNT_HELP}`);
  }
}

/**
 * GET /2/users/me — the authenticated user. User-context only (no App-only Bearer);
 * the CLI enforces the credential requirement at makeClient time.
 */
async function whoami(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { ...addFieldFlags() },
    allowPositionals: true,
    strict: true,
  });

  const result = await client.get('/users/me', { ...collectFieldParams(values) });
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

/**
 * Makes a single cheap read and prints the captured rate-limit signal
 * (`client.lastRateLimit`) rather than the response body — a quota probe.
 *
 * - Default probe: GET /2/users/me (works under a user token).
 * - With `--username <handle>`: GET /2/users/by/username/{handle} (works under Bearer),
 *   so the probe is usable with an app-only token too.
 */
async function rateLimit(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { username: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });

  const username = values['username'];
  const path = username ? `/users/by/username/${encodeURIComponent(username)}` : '/users/me';
  await client.get(path);

  process.stdout.write(safeStringify(client.lastRateLimit, collectSecrets(cfg)) + '\n');
}
