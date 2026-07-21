import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import { addFieldFlags, collectFieldParams, paginate, parseMaxPages } from '../utils.js';
import type { XClientConfig, XEnvelope } from '../types.js';

export const BOOKMARK_HELP = `x bookmark <list|add|remove> [flags]

  list      List your bookmarks   GET    /2/users/{id}/bookmarks
              --id <id>        the authenticated user's ID           (required)
              --max-results <n>, --all, --max-pages <n>, + field flags
  add       Add a bookmark        POST   /2/users/{id}/bookmarks   body {tweet_id}
              --user-id <id>   the authenticated user's ID           (required)
              --tweet-id <id>  the Post to bookmark                  (required)
  remove    Remove a bookmark     DELETE /2/users/{id}/bookmarks/{tweet_id}
              --user-id <id>   the authenticated user's ID           (required)
              --tweet-id <id>  the bookmarked Post to remove         (required)

Auth: OAuth 2.0 user token ONLY (scopes bookmark.read/bookmark.write + tweet.read + users.read).
  This is the strictest surface — NO App-only Bearer and NO OAuth 1.0a alternative exists.`;

export async function runBookmark(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return list(client, rest, cfg);
    case 'add':
      return add(client, rest, cfg);
    case 'remove':
      return remove(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${BOOKMARK_HELP}`);
  }
}

async function list(
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
  if (!id) throw new UsageError('--id is required');

  const maxResults = values['max-results'] as string | undefined;
  const all = values['all'] === true;
  const maxPagesRaw = values['max-pages'] as string | undefined;
  const maxPages = maxPagesRaw !== undefined ? parseMaxPages(maxPagesRaw) : undefined;
  const fieldParams = collectFieldParams(values);

  const path = `/users/${id}/bookmarks`;

  // Single-page mode (no --all / --max-pages): print the FULL envelope so meta and
  // any partial errors[] stay visible.
  if (!all && maxPages === undefined) {
    const result = await client.get<XEnvelope<unknown[]>>(path, {
      max_results: maxResults,
      ...fieldParams,
    });
    process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
    return;
  }

  // Paginated mode: accumulate data[] across pages, following meta.next_token via
  // the pagination_token request param.
  const items = await paginate<unknown>(
    async (token) => {
      const page = await client.get<XEnvelope<unknown[]>>(path, {
        max_results: maxResults,
        pagination_token: token,
        ...fieldParams,
      });
      return {
        items: Array.isArray(page.data) ? page.data : [],
        nextToken: page.meta?.next_token,
      };
    },
    { all, maxPages },
  );

  process.stdout.write(safeStringify({ data: items }, collectSecrets(cfg)) + '\n');
}

async function add(
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
  if (!userId) throw new UsageError('--user-id is required');
  if (!tweetId) throw new UsageError('--tweet-id is required');

  const result = await client.post(`/users/${userId}/bookmarks`, {
    tweet_id: tweetId,
  });
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

async function remove(
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
  if (!userId) throw new UsageError('--user-id is required');
  if (!tweetId) throw new UsageError('--tweet-id is required');

  const result = await client.delete(`/users/${userId}/bookmarks/${tweetId}`);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}
