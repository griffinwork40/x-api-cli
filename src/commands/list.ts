import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import {
  addFieldFlags,
  collectFieldParams,
  paginate,
  parseMaxPages,
} from '../utils.js';
import type { XClientConfig, XEnvelope } from '../types.js';

export const LIST_HELP = `x list <get|create|update|delete|members-list|members-add|members-remove|tweets|owned> [flags]
  get             --id <listId> [--list-fields ..] [--expansions owner_id]      (read)
  create          --name <s> [--description <s>] [--private]                    (write)
  update          --id <listId> [--name <s>] [--description <s>] [--private]    (write)
  delete          --id <listId>                                                 (write)
  members-list    --id <listId> [--all] [--max-pages <n>]                       (read)
  members-add     --id <listId> --user-id <userId>                              (write)
  members-remove  --id <listId> --user-id <userId>                              (write)
  tweets          --id <listId> [--all] [--max-pages <n>]                       (read)
  owned           --id <userId> [--all] [--max-pages <n>]                       (read)`;

export async function runList(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'get':
      return get(client, rest, cfg);
    case 'create':
      return create(client, rest, cfg);
    case 'update':
      return update(client, rest, cfg);
    case 'delete':
      return del(client, rest, cfg);
    case 'members-list':
      return membersList(client, rest, cfg);
    case 'members-add':
      return membersAdd(client, rest, cfg);
    case 'members-remove':
      return membersRemove(client, rest, cfg);
    case 'tweets':
      return tweets(client, rest, cfg);
    case 'owned':
      return owned(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${LIST_HELP}`);
  }
}

function print(data: unknown, cfg: XClientConfig): void {
  process.stdout.write(safeStringify(data, collectSecrets(cfg)) + '\n');
}

// ─── get (read) ───────────────────────────────────────────────────────────────

async function get(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { id: { type: 'string' }, ...addFieldFlags() },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  const result = await client.get(`/lists/${id}`, { ...collectFieldParams(values) });
  print(result, cfg);
}

// ─── create (write) ─────────────────────────────────────────────────────────────

async function create(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      private: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const name = values['name'];
  if (!name) throw new UsageError('--name is required. ' + LIST_HELP);
  const body: Record<string, unknown> = { name };
  if (values['description'] !== undefined) body['description'] = values['description'];
  if (values['private'] !== undefined) body['private'] = values['private'];
  const result = await client.post('/lists', body);
  print(result, cfg);
}

// ─── update (write) ─────────────────────────────────────────────────────────────

async function update(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      private: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  const body: Record<string, unknown> = {};
  if (values['name'] !== undefined) body['name'] = values['name'];
  if (values['description'] !== undefined) body['description'] = values['description'];
  if (values['private'] !== undefined) body['private'] = values['private'];
  const result = await client.put(`/lists/${id}`, body);
  print(result, cfg);
}

// ─── delete (write) ─────────────────────────────────────────────────────────────

async function del(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { id: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  const result = await client.delete(`/lists/${id}`);
  print(result, cfg);
}

// ─── members-list (read, paginated) ─────────────────────────────────────────────

async function membersList(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      all: { type: 'boolean' },
      'max-pages': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  const fields = collectFieldParams(values);
  const maxPages = values['max-pages'] ? parseMaxPages(values['max-pages']) : undefined;

  const items = await paginate<unknown>(
    async (token) => {
      const params: Record<string, string | undefined> = { ...fields };
      if (token) params['pagination_token'] = token;
      const page = (await client.get(`/lists/${id}/members`, params)) as XEnvelope<unknown[]>;
      return { items: page.data ?? [], nextToken: page.meta?.next_token };
    },
    { all: Boolean(values['all']), maxPages },
  );
  print({ data: items, meta: { result_count: items.length } }, cfg);
}

// ─── members-add (write) ─────────────────────────────────────────────────────────

async function membersAdd(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { id: { type: 'string' }, 'user-id': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  const userId = values['user-id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  if (!userId) throw new UsageError('--user-id is required. ' + LIST_HELP);
  const result = await client.post(`/lists/${id}/members`, { user_id: userId });
  print(result, cfg);
}

// ─── members-remove (write) ───────────────────────────────────────────────────

async function membersRemove(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { id: { type: 'string' }, 'user-id': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  const userId = values['user-id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  if (!userId) throw new UsageError('--user-id is required. ' + LIST_HELP);
  const result = await client.delete(`/lists/${id}/members/${userId}`);
  print(result, cfg);
}

// ─── tweets (read, paginated) ───────────────────────────────────────────────────

async function tweets(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      all: { type: 'boolean' },
      'max-pages': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  const fields = collectFieldParams(values);
  const maxPages = values['max-pages'] ? parseMaxPages(values['max-pages']) : undefined;

  const items = await paginate<unknown>(
    async (token) => {
      const params: Record<string, string | undefined> = { ...fields };
      if (token) params['pagination_token'] = token;
      const page = (await client.get(`/lists/${id}/tweets`, params)) as XEnvelope<unknown[]>;
      return { items: page.data ?? [], nextToken: page.meta?.next_token };
    },
    { all: Boolean(values['all']), maxPages },
  );
  print({ data: items, meta: { result_count: items.length } }, cfg);
}

// ─── owned (read, paginated) ─────────────────────────────────────────────────────

async function owned(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      all: { type: 'boolean' },
      'max-pages': { type: 'string' },
      ...addFieldFlags(),
    },
    allowPositionals: true,
    strict: true,
  });
  const id = values['id'];
  if (!id) throw new UsageError('--id is required. ' + LIST_HELP);
  const fields = collectFieldParams(values);
  const maxPages = values['max-pages'] ? parseMaxPages(values['max-pages']) : undefined;

  const items = await paginate<unknown>(
    async (token) => {
      const params: Record<string, string | undefined> = { ...fields };
      if (token) params['pagination_token'] = token;
      const page = (await client.get(`/users/${id}/owned_lists`, params)) as XEnvelope<unknown[]>;
      return { items: page.data ?? [], nextToken: page.meta?.next_token };
    },
    { all: Boolean(values['all']), maxPages },
  );
  print({ data: items, meta: { result_count: items.length } }, cfg);
}
