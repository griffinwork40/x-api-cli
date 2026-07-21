import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import {
  addFieldFlags,
  collectFieldParams,
  parsePositiveInt,
  parseMaxPages,
  paginate,
} from '../utils.js';
import type { XClientConfig, XEnvelope } from '../types.js';

export const SEARCH_HELP = `x search <recent|all|counts> [flags]
  recent   GET /2/tweets/search/recent  (read — Bearer OK)
             --query <q>  (required)
             --max-results <10-100>, --start-time, --end-time,
             --since-id, --until-id, --sort-order <recency|relevancy>,
             --all | --max-pages <n>   + field/expansion flags
  all      GET /2/tweets/search/all  (full-archive — App-only Bearer ONLY; Pro/Enterprise)
             same flags as recent (--max-results up to 500)
  counts   GET /2/tweets/counts/recent  (or --all → /2/tweets/counts/all)  (Bearer ONLY)
             --query <q>  (required)
             --granularity <minute|hour|day>  (default hour),
             --start-time, --end-time, --since-id, --until-id,
             --search-count-fields
           (prints meta.total_tweet_count + data[])`;

export async function runSearch(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'recent':
      return search(client, rest, cfg, '/tweets/search/recent');
    case 'all':
      return search(client, rest, cfg, '/tweets/search/all');
    case 'counts':
      return counts(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${SEARCH_HELP}`);
  }
}

/**
 * Shared recent/all search. `path` selects the endpoint.
 *   recent → GET /2/tweets/search/recent   (read; Bearer OK)
 *   all    → GET /2/tweets/search/all       (full-archive; App-only Bearer only)
 *
 * Supports `--all` / `--max-pages` cursor pagination on `meta.next_token`
 * (sent back as `pagination_token`, which works on every X endpoint).
 */
async function search(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
  path: string,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      query: { type: 'string' },
      'max-results': { type: 'string' },
      'start-time': { type: 'string' },
      'end-time': { type: 'string' },
      'since-id': { type: 'string' },
      'until-id': { type: 'string' },
      'sort-order': { type: 'string' },
      all: { type: 'boolean' },
      'max-pages': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });

  const query = values['query'];
  if (!query) throw new UsageError('--query is required');

  const maxResults =
    values['max-results'] !== undefined
      ? parsePositiveInt(values['max-results'], '--max-results')
      : undefined;
  const maxPages =
    values['max-pages'] !== undefined ? parseMaxPages(values['max-pages']) : undefined;
  const all = values['all'] === true;

  const baseParams = {
    query,
    max_results: maxResults,
    start_time: values['start-time'] ?? undefined,
    end_time: values['end-time'] ?? undefined,
    since_id: values['since-id'] ?? undefined,
    until_id: values['until-id'] ?? undefined,
    sort_order: values['sort-order'] ?? undefined,
    ...collectFieldParams(values),
  };

  // Single page (default) unless --all / --max-pages requested pagination.
  if (!all && maxPages === undefined) {
    const result = await client.get(path, baseParams);
    process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
    return;
  }

  const items = await paginate<unknown>(
    async (token) => {
      const env = await client.get<XEnvelope<unknown[]>>(path, {
        ...baseParams,
        pagination_token: token ?? undefined,
      });
      return { items: env.data ?? [], nextToken: env.meta?.next_token };
    },
    { all, maxPages },
  );

  process.stdout.write(safeStringify({ data: items }, collectSecrets(cfg)) + '\n');
}

/**
 * GET /2/tweets/counts/recent (default) or /2/tweets/counts/all (with --all).
 * Auth: App-only Bearer only. Prints `meta.total_tweet_count` alongside `data[]`.
 */
async function counts(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      query: { type: 'string' },
      granularity: { type: 'string' },
      'start-time': { type: 'string' },
      'end-time': { type: 'string' },
      'since-id': { type: 'string' },
      'until-id': { type: 'string' },
      all: { type: 'boolean' },
      'search-count-fields': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const query = values['query'];
  if (!query) throw new UsageError('--query is required');

  const path = values['all'] === true ? '/tweets/counts/all' : '/tweets/counts/recent';

  const result = await client.get<XEnvelope<unknown[]>>(path, {
    query,
    granularity: values['granularity'] ?? undefined,
    start_time: values['start-time'] ?? undefined,
    end_time: values['end-time'] ?? undefined,
    since_id: values['since-id'] ?? undefined,
    until_id: values['until-id'] ?? undefined,
    ...collectFieldParams(values),
  });

  // Surface the headline total explicitly alongside the buckets + any partial errors.
  const toPrint = {
    total_tweet_count: result.meta?.total_tweet_count,
    data: result.data,
    meta: result.meta,
    ...(result.errors ? { errors: result.errors } : {}),
  };
  process.stdout.write(safeStringify(toPrint, collectSecrets(cfg)) + '\n');
}
