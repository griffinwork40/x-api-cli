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

export const RETWEET_HELP = `x retweet <create|delete|retweeted-by|quote-tweets> [flags]
  create        --user-id <id> --tweet-id <id>                       [write]
  delete        --user-id <id> --tweet-id <sourceTweetId>            [write]
  retweeted-by  --id <tweetId> [--max-results <1-100>] [--all] [--max-pages <n>]   [read]
  quote-tweets  --id <tweetId> [--exclude <replies,retweets>] [--all] [--max-pages <n>]  [read]`;

export async function runRetweet(
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
    case 'retweeted-by':
      return retweetedBy(client, rest, cfg);
    case 'quote-tweets':
      return quoteTweets(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${RETWEET_HELP}`);
  }
}

// ─── create — POST /2/users/{id}/retweets body {tweet_id} (write) ────────────────

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

  const result = await client.post(`/users/${encodeURIComponent(userId)}/retweets`, {
    tweet_id: tweetId,
  });
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── delete — DELETE /2/users/{id}/retweets/{source_tweet_id} (write) ────────────
// --tweet-id maps to the {source_tweet_id} path segment (OpenAPI param name).

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
  const sourceTweetId = values['tweet-id'] as string | undefined;
  if (!userId) throw new UsageError('--user-id <id> is required');
  if (!sourceTweetId) throw new UsageError('--tweet-id <sourceTweetId> is required');

  const result = await client.delete(
    `/users/${encodeURIComponent(userId)}/retweets/${encodeURIComponent(sourceTweetId)}`,
  );
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── retweeted-by — GET /2/tweets/{id}/retweeted_by (read, paginated) ────────────

async function retweetedBy(
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

  const extra = collectFieldParams(values);
  await paginatePrint(client, cfg, `/tweets/${encodeURIComponent(id)}/retweeted_by`, values, extra);
}

// ─── quote-tweets — GET /2/tweets/{id}/quote_tweets (read, paginated) ────────────

async function quoteTweets(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      exclude: { type: 'string' },
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

  const exclude = values['exclude'] as string | undefined;
  const extra: Record<string, string | undefined> = {
    exclude,
    ...collectFieldParams(values),
  };
  await paginatePrint(client, cfg, `/tweets/${encodeURIComponent(id)}/quote_tweets`, values, extra);
}

/** Shared cursor-paginate + print for the two engagement reads. */
async function paginatePrint(
  client: XClient,
  cfg: XClientConfig,
  path: string,
  values: Record<string, unknown>,
  extraParams: Record<string, string | undefined>,
): Promise<void> {
  const maxResultsRaw = values['max-results'] as string | undefined;
  const maxResults = maxResultsRaw
    ? String(parsePositiveInt(maxResultsRaw, '--max-results'))
    : undefined;
  const all = Boolean(values['all']);
  const maxPagesRaw = values['max-pages'] as string | undefined;
  const maxPages = maxPagesRaw ? parseMaxPages(maxPagesRaw) : undefined;

  const items = await paginate<unknown>(
    async (token) => {
      const params: Record<string, string | undefined> = {
        max_results: maxResults,
        pagination_token: token,
        ...extraParams,
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
