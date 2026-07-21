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

export const USER_HELP = `x user <get|me|followers|following> [flags]
  get        --id <id> | --ids <csv> | --username <handle> | --usernames <csv>  (exactly one)  [read]
  me                                                                            [user context]
  followers  --id <userId> [--max-results <1-1000>] [--all] [--max-pages <n>]   [read]
  following  --id <userId> [--max-results <1-1000>] [--all] [--max-pages <n>]   [read]`;

export async function runUser(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'get':
      return get(client, rest, cfg);
    case 'me':
      return me(client, rest, cfg);
    case 'followers':
      return followers(client, rest, cfg);
    case 'following':
      return following(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${USER_HELP}`);
  }
}

// ─── get — 4 lookup variants; exactly one of --id/--ids/--username/--usernames ──

async function get(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      ids: { type: 'string' },
      username: { type: 'string' },
      usernames: { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });

  const id = values['id'] as string | undefined;
  const ids = values['ids'] as string | undefined;
  const username = values['username'] as string | undefined;
  const usernames = values['usernames'] as string | undefined;

  const provided = [id, ids, username, usernames].filter(
    (v) => v !== undefined,
  ).length;
  if (provided !== 1) {
    throw new UsageError(
      'exactly one of --id, --ids, --username, --usernames is required',
    );
  }

  const fields = collectFieldParams(values);
  let path: string;
  let params: Record<string, string | undefined> = { ...fields };

  if (id) {
    path = `/users/${encodeURIComponent(id)}`;
  } else if (username) {
    path = `/users/by/username/${encodeURIComponent(username)}`;
  } else if (ids) {
    path = '/users';
    params = { ids, ...fields };
  } else {
    path = '/users/by';
    params = { usernames, ...fields };
  }

  const result = await client.get(path, params);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── me — GET /2/users/me (user context only) ───────────────────────────────────

async function me(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { ...addFieldFlags() },
    allowPositionals: true,
    strict: true,
  });
  const result = await client.get('/users/me', collectFieldParams(values));
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── followers / following — paginated collections ──────────────────────────────

async function followers(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  return listFollows(client, rest, cfg, 'followers');
}

async function following(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  return listFollows(client, rest, cfg, 'following');
}

async function listFollows(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
  kind: 'followers' | 'following',
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

  const maxResultsRaw = values['max-results'] as string | undefined;
  const maxResults = maxResultsRaw
    ? String(parsePositiveInt(maxResultsRaw, '--max-results'))
    : undefined;
  const all = Boolean(values['all']);
  const maxPagesRaw = values['max-pages'] as string | undefined;
  const maxPages = maxPagesRaw ? parseMaxPages(maxPagesRaw) : undefined;
  const fields = collectFieldParams(values);

  const path = `/users/${encodeURIComponent(id)}/${kind}`;

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
