import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import { addFieldFlags, collectFieldParams, parsePositiveInt } from '../utils.js';
import type { XClientConfig } from '../types.js';

export const SPACE_HELP = `x space <get|search> [flags]
  get     --id <spaceId> | --ids <csv>  (exactly one)  [+ --space-fields/--topic-fields/--user-fields/--expansions]  [read]
  search  --query <q> [--state <live|scheduled|all>] [--max-results <1-100>]                                          [read]`;

const VALID_STATES = new Set(['live', 'scheduled', 'all']);

export async function runSpace(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'get':
      return get(client, rest, cfg);
    case 'search':
      return search(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${SPACE_HELP}`);
  }
}

// ─── get — GET /2/spaces/{id} | GET /2/spaces?ids= (read) ────────────────────────

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
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });

  const id = values['id'] as string | undefined;
  const ids = values['ids'] as string | undefined;

  const provided = [id, ids].filter((v) => v !== undefined).length;
  if (provided !== 1) {
    throw new UsageError('exactly one of --id, --ids is required');
  }

  const fields = collectFieldParams(values);
  let path: string;
  let params: Record<string, string | undefined>;
  if (id) {
    path = `/spaces/${encodeURIComponent(id)}`;
    params = { ...fields };
  } else {
    path = '/spaces';
    params = { ids, ...fields };
  }

  const result = await client.get(path, params);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── search — GET /2/spaces/search (read; NOT cursor-paginated) ──────────────────

async function search(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      query: { type: 'string' },
      state: { type: 'string' },
      'max-results': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });

  const query = values['query'] as string | undefined;
  if (!query) throw new UsageError('--query <q> is required');

  const state = values['state'] as string | undefined;
  if (state !== undefined && !VALID_STATES.has(state)) {
    throw new UsageError('--state must be one of: live, scheduled, all');
  }

  const maxResultsRaw = values['max-results'] as string | undefined;
  const maxResults = maxResultsRaw
    ? String(parsePositiveInt(maxResultsRaw, '--max-results'))
    : undefined;

  const params: Record<string, string | undefined> = {
    query,
    state,
    max_results: maxResults,
    ...collectFieldParams(values),
  };

  const result = await client.get('/spaces/search', params);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}
