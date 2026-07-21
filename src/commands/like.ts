import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import {
  addFieldFlags,
  collectFieldParams,
  paginate,
  parseMaxPages,
  parsePositiveInt,
} from '../utils.js';
import type { XClientConfig, XEnvelope } from '../types.js';

export const LIKE_HELP = `x like <create|delete|liking-users|liked-tweets> [flags]
  create        --user-id <id> --tweet-id <id>                       [write]
  delete        --user-id <id> --tweet-id <id>                       [write]
  liking-users  --id <tweetId> [--max-results <1-100>] [--all] [--max-pages <n>]  [user context]
  liked-tweets  --id <userId>  [--max-results <5-100>] [--all] [--max-pages <n>]  [user context]`;

export async function runLike(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'create':
      return create(client, rest, cfg);
    case 'delete':
      return del(client, rest, cfg);
    case 'liking-users':
      return likingUsers(client, rest, cfg);
    case 'liked-tweets':
      return likedTweets(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${LIKE_HELP}`);
  }
}

// ─── create — POST /2/users/{id}/likes body {tweet_id} (write) ───────────────────

async function create(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      'user-id': { type: 'string' },
      'tweet-id': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const userId = values['user-id'] as string | undefined;
  const tweetId = values['tweet-id'] as string | undefined;
  if (!userId) throw new UsageError('--user-id <id> is required');
  if (!tweetId) throw new UsageError('--tweet-id <id> is required');

  const result = await client.post(`/users/${encodeURIComponent(userId)}/likes`, {
    tweet_id: tweetId,
  });
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── delete — DELETE /2/users/{id}/likes/{tweet_id} (write) ──────────────────────

async function del(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      'user-id': { type: 'string' },
      'tweet-id': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const userId = values['user-id'] as string | undefined;
  const tweetId = values['tweet-id'] as string | undefined;
  if (!userId) throw new UsageError('--user-id <id> is required');
  if (!tweetId) throw new UsageError('--tweet-id <id> is required');

  const result = await client.delete(
    `/users/${encodeURIComponent(userId)}/likes/${encodeURIComponent(tweetId)}`,
  );
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── liking-users — GET /2/tweets/{id}/liking_users (user context, paginated) ────

async function likingUsers(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      'max-results': { type: 'string' },
      all: { type: 'boolean' },
      'max-pages': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });

  const id = values['id'] as string | undefined;
  if (!id) throw new UsageError('--id <tweetId> is required');

  await paginatePrint(client, cfg, `/tweets/${encodeURIComponent(id)}/liking_users`, values);
}

// ─── liked-tweets — GET /2/users/{id}/liked_tweets (user context, paginated) ─────

async function likedTweets(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      'max-results': { type: 'string' },
      all: { type: 'boolean' },
      'max-pages': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });

  const id = values['id'] as string | undefined;
  if (!id) throw new UsageError('--id <userId> is required');

  await paginatePrint(client, cfg, `/users/${encodeURIComponent(id)}/liked_tweets`, values);
}

/** Shared cursor-paginate + print for the two engagement reads. */
async function paginatePrint(
  client: XClient,
  cfg: XClientConfig,
  path: string,
  values: Record<string, unknown>,
): Promise<void> {
  const maxResultsRaw = values['max-results'] as string | undefined;
  const maxResults = maxResultsRaw
    ? String(parsePositiveInt(maxResultsRaw, '--max-results'))
    : undefined;
  const all = Boolean(values['all']);
  const maxPagesRaw = values['max-pages'] as string | undefined;
  const maxPages = maxPagesRaw ? parseMaxPages(maxPagesRaw) : undefined;
  const fields = collectFieldParams(values);

  const items = await paginate<unknown>(
    async (token) => {
      const params: Record<string, string | undefined> = {
        max_results: maxResults,
        pagination_token: token,
        ...fields,
      };
      const page = (await client.get(path, params)) as XEnvelope<unknown[]>;
      return {
        items: Array.isArray(page.data) ? page.data : [],
        nextToken: page.meta?.next_token,
      };
    },
    { all, maxPages },
  );

  process.stdout.write(safeStringify(items, collectSecrets(cfg)) + '\n');
}
