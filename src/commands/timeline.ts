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

export const TIMELINE_HELP = `x timeline <posts|mentions|home> [flags]
  posts     GET /2/users/{id}/tweets  (read — Bearer OK)
              --id <userId>  (required)
              --max-results <5-100>, --exclude <replies,retweets>,
              --start-time, --end-time, --since-id, --until-id,
              --all | --max-pages <n>   + field/expansion flags
  mentions  GET /2/users/{id}/mentions  (read — Bearer OK)
              --id <userId>  (required)   (same options, no --exclude)
  home      GET /2/users/{id}/timelines/reverse_chronological  (user context ONLY)
              --id <userId>  (must be the authenticated user)`;

export async function runTimeline(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'posts':
      return timeline(client, rest, cfg, 'posts');
    case 'mentions':
      return timeline(client, rest, cfg, 'mentions');
    case 'home':
      return timeline(client, rest, cfg, 'home');
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${TIMELINE_HELP}`);
  }
}

type Kind = 'posts' | 'mentions' | 'home';

const PATH_SUFFIX: Record<Kind, string> = {
  posts: 'tweets',
  mentions: 'mentions',
  home: 'timelines/reverse_chronological',
};

/**
 * Shared timeline reader for all three collection endpoints:
 *   posts     → GET /2/users/{id}/tweets                         (Bearer OK)
 *   mentions  → GET /2/users/{id}/mentions                        (Bearer OK)
 *   home      → GET /2/users/{id}/timelines/reverse_chronological (user context only)
 *
 * `--exclude` is only accepted for `posts`. All support `--all` / `--max-pages`
 * cursor pagination on `meta.next_token` (sent back as `pagination_token`).
 */
async function timeline(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
  kind: Kind,
): Promise<void> {
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    id: { type: 'string' },
    'max-results': { type: 'string' },
    'start-time': { type: 'string' },
    'end-time': { type: 'string' },
    'since-id': { type: 'string' },
    'until-id': { type: 'string' },
    all: { type: 'boolean' },
    'max-pages': { type: 'string' },
    ...addFieldFlags(),
  };
  // `--exclude` (replies,retweets) is only valid on the user's own Posts timeline.
  if (kind === 'posts') options['exclude'] = { type: 'string' };

  const { values } = parseArgs({ args: rest, options, allowPositionals: true, strict: true });

  const id = values['id'];
  if (!id || typeof id !== 'string') throw new UsageError('--id (user id) is required');

  const path = `/users/${encodeURIComponent(id)}/${PATH_SUFFIX[kind]}`;

  const maxResults =
    values['max-results'] !== undefined
      ? parsePositiveInt(values['max-results'] as string, '--max-results')
      : undefined;
  const maxPages =
    values['max-pages'] !== undefined ? parseMaxPages(values['max-pages'] as string) : undefined;
  const all = values['all'] === true;

  const baseParams = {
    max_results: maxResults,
    exclude: kind === 'posts' ? ((values['exclude'] as string | undefined) ?? undefined) : undefined,
    start_time: (values['start-time'] as string | undefined) ?? undefined,
    end_time: (values['end-time'] as string | undefined) ?? undefined,
    since_id: (values['since-id'] as string | undefined) ?? undefined,
    until_id: (values['until-id'] as string | undefined) ?? undefined,
    ...collectFieldParams(values),
  };

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
