import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import type { XClientConfig } from '../types.js';

export const FOLLOW_HELP = `x follow <follow|unfollow> [flags]

  follow    Follow a user            POST   /2/users/{id}/following   (write — user context)
              --user-id <id>   the source/authenticated user's ID   (required)
              --target <id>    the user ID to follow                 (required)
  unfollow  Unfollow a user          DELETE /2/users/{source}/following/{target}   (write)
              --user-id <id>   the source/authenticated user's ID   (required)
              --target <id>    the user ID to unfollow               (required)

Auth: write — requires a user context (OAuth 1.0a or OAuth 2.0 user token; App-only Bearer is rejected).`;

export async function runFollow(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'follow':
      return follow(client, rest, cfg);
    case 'unfollow':
      return unfollow(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${FOLLOW_HELP}`);
  }
}

async function follow(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
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

  const result = await client.post(`/users/${userId}/following`, {
    target_user_id: target,
  });
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

async function unfollow(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
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

  const result = await client.delete(`/users/${userId}/following/${target}`);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}
