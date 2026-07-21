import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import type { XClientConfig } from '../types.js';

export const RELATIONSHIP_HELP = `x relationship <mute|unmute|block|unblock> [flags]

  mute      Mute a user      POST   /2/users/{id}/muting     (write — user context)
  unmute    Unmute a user    DELETE /2/users/{source}/muting/{target}     (write)
  block     Block a user     POST   /2/users/{id}/blocking   (write — user context)
  unblock   Unblock a user   DELETE /2/users/{source}/blocking/{target}   (write)

  Flags (all sub-actions):
    --user-id <id>   the source/authenticated user's ID   (required)
    --target <id>    the target user's ID                 (required)

Auth: write — requires a user context (OAuth 1.0a or OAuth 2.0 user token; App-only Bearer is rejected).

⚠️  block/unblock availability is in flux — some doc mirrors flag the block surface as
    potentially Enterprise-only / not guaranteed on self-serve tiers. Verify against docs.x.com
    before relying on it; a 403 client-forbidden here likely means your tier lacks block access.`;

export async function runRelationship(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'mute':
      return toggle(client, rest, cfg, 'POST', 'muting');
    case 'unmute':
      return toggle(client, rest, cfg, 'DELETE', 'muting');
    case 'block':
      return toggle(client, rest, cfg, 'POST', 'blocking');
    case 'unblock':
      return toggle(client, rest, cfg, 'DELETE', 'blocking');
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${RELATIONSHIP_HELP}`);
  }
}

/**
 * Parses the shared `--user-id`/`--target` flags, then issues the relationship
 * mutation. `POST` creates the relationship (`/users/{id}/{resource}` with a
 * `{target_user_id}` body); `DELETE` removes it (`/users/{source}/{resource}/{target}`).
 */
async function toggle(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
  method: 'POST' | 'DELETE',
  resource: 'muting' | 'blocking',
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      'user-id': { type: 'string' },
      target: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const userId = values['user-id'] as string | undefined;
  const target = values['target'] as string | undefined;
  if (!userId) throw new UsageError('--user-id is required');
  if (!target) throw new UsageError('--target is required');

  const result =
    method === 'POST'
      ? await client.post(`/users/${userId}/${resource}`, { target_user_id: target })
      : await client.delete(`/users/${userId}/${resource}/${target}`);

  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}
