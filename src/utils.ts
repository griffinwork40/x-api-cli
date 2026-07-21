import { UsageError } from './errors.js';

/**
 * Builds a query-param record suitable for URLSearchParams.
 * Drops undefined and null. Coerces everything else (including '', false, 0) to string.
 */
export function buildQueryParams(
  args: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    result[key] = String(value);
  }
  return result;
}

/**
 * Pretty-prints any value as JSON with 2-space indentation.
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Parses a base-10 integer from a string; throws a {@link UsageError} if invalid or <= 0.
 * (Command flags are user input; a bad value is a usage error → exit 1.)
 */
export function parsePositiveInt(value: string, flagName: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0 || String(n) !== value.trim()) {
    throw new UsageError(`${flagName} must be a positive integer`);
  }
  return n;
}

/**
 * Returns a promise that resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Field / expansion flags (X v2) ─────────────────────────────────────────────

/**
 * The CLI-facing field/expansion flag → API query-param key mapping.
 * All of X's per-object `*.fields` params plus `expansions`, exposed to the user as
 * kebab-case flags. `search-count-fields` maps to `search_count.fields` (underscore).
 */
const FIELD_FLAG_MAP: Record<string, string> = {
  'tweet-fields': 'tweet.fields',
  'user-fields': 'user.fields',
  'media-fields': 'media.fields',
  'poll-fields': 'poll.fields',
  'place-fields': 'place.fields',
  'space-fields': 'space.fields',
  'list-fields': 'list.fields',
  'topic-fields': 'topic.fields',
  'search-count-fields': 'search_count.fields',
  expansions: 'expansions',
};

/**
 * Returns the `parseArgs` options-spec fragment for every field/expansion flag.
 * Commands spread this into their own options: `{ id: {...}, ...addFieldFlags() }`.
 */
export function addFieldFlags(): Record<string, { type: 'string' }> {
  const spec: Record<string, { type: 'string' }> = {};
  for (const flag of Object.keys(FIELD_FLAG_MAP)) {
    spec[flag] = { type: 'string' };
  }
  return spec;
}

/**
 * Maps parsed field/expansion flag values to their API query-param keys, dropping
 * any that were not supplied. Feed the result straight into `client.get(path, params)`.
 */
export function collectFieldParams(
  values: Record<string, unknown>,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [flag, apiKey] of Object.entries(FIELD_FLAG_MAP)) {
    const v = values[flag];
    if (typeof v === 'string' && v.length > 0) {
      params[apiKey] = v;
    }
  }
  return params;
}

// ─── Pagination ─────────────────────────────────────────────────────────────────

/**
 * Parses a positive integer `--max-pages` value; throws {@link UsageError} otherwise.
 */
export function parseMaxPages(value: string): number {
  return parsePositiveInt(value, '--max-pages');
}

/**
 * Cursor-follows a paginated endpoint, accumulating items across pages.
 *
 * `fetchPage(token)` returns one page `{ items, nextToken }`. Looping rules:
 *  - Always fetch page 1.
 *  - Continue only while `nextToken` is present AND (`opts.all` OR more `maxPages` remain).
 *  - With neither `all` nor `maxPages`, fetch a single page (the caller wants just page 1).
 *  - `maxPages` caps the number of pages fetched even when `all` is set.
 */
export async function paginate<T>(
  fetchPage: (token?: string) => Promise<{ items: T[]; nextToken?: string }>,
  opts: { all?: boolean; maxPages?: number },
): Promise<T[]> {
  const acc: T[] = [];
  let token: string | undefined = undefined;
  let page = 0;
  const cap = opts.maxPages;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { items, nextToken } = await fetchPage(token);
    acc.push(...items);
    page += 1;

    if (!nextToken) break; // no more pages
    if (cap !== undefined && page >= cap) break; // hit page cap
    if (!opts.all && cap === undefined) break; // single-page mode
    token = nextToken;
  }

  return acc;
}

// ─── Positional guard (noUncheckedIndexedAccess helper) ─────────────────────────

/**
 * Returns `positionals[0]` or throws {@link UsageError} — DRY for the
 * `noUncheckedIndexedAccess` guard (`positionals[0]` is `string | undefined`).
 */
export function assertOne(positionals: (string | undefined)[], name: string): string {
  const first = positionals[0];
  if (first === undefined || first === '') {
    throw new UsageError(`${name} is required`);
  }
  return first;
}
