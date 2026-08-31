import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import type { XClientConfig } from '../types.js';

export const ARTICLE_HELP = `x article <draft|publish> [flags]
  draft    POST /2/articles/draft  (write — user context, Premium required)
             --title <s>                (article title — required)
             --content-file <path>      (path to DraftJS content_state JSON file)
             --content-json <json>      (inline DraftJS content_state JSON string)
             --cover-media-id <id>      (optional cover image media_id)
           (exactly one of --content-file or --content-json is required)
  publish  POST /2/articles/{article_id}/publish  (write — user context, Premium required)
             --id <article_id>   (or positional)

Note: article creation uses the DraftJS content_state format. A minimal example:
  {"blocks":[{"text":"Hello world","key":"a1"}],"entities":[]}

Reading article content: use 'x tweet get --id <id> --tweet-fields article'
  to retrieve article.title and article.plain_text from the wrapper tweet.`;

export async function runArticle(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'draft':
      return draft(client, rest, cfg);
    case 'publish':
      return publish(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${ARTICLE_HELP}`);
  }
}

// ─── draft ──────────────────────────────────────────────────────────────────

/**
 * POST /2/articles/draft — create a draft Article.
 * Auth: write (user context, Premium required to eventually publish).
 *
 * Body:
 *   --title            → title (required)
 *   --content-file     → reads file, parses as JSON → content_state
 *   --content-json     → parses inline string as JSON → content_state
 *   --cover-media-id   → cover_media.media_id (optional)
 */
async function draft(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      title: { type: 'string' },
      'content-file': { type: 'string' },
      'content-json': { type: 'string' },
      'cover-media-id': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });

  const title = values['title']?.trim();
  if (!title) throw new UsageError('--title is required');

  const contentFile = values['content-file'];
  const contentJson = values['content-json'];

  if (!contentFile && !contentJson) {
    throw new UsageError('exactly one of --content-file or --content-json is required');
  }
  if (contentFile && contentJson) {
    throw new UsageError('--content-file and --content-json are mutually exclusive');
  }

  let contentState: unknown;
  if (contentFile) {
    let raw: string;
    try {
      raw = await readFile(contentFile, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new UsageError(
        code === 'ENOENT'
          ? `--content-file '${contentFile}': file not found`
          : `--content-file '${contentFile}': could not read file (${code ?? String(err)})`,
      );
    }
    try {
      contentState = JSON.parse(raw);
    } catch {
      throw new UsageError(`--content-file '${contentFile}' is not valid JSON`);
    }
  } else {
    try {
      contentState = JSON.parse(contentJson as string);
    } catch {
      throw new UsageError('--content-json is not valid JSON');
    }
  }

  const body: Record<string, unknown> = {
    title,
    content_state: contentState,
  };

  const coverMediaId = values['cover-media-id'];
  if (coverMediaId) {
    body['cover_media'] = { media_id: coverMediaId };
  }

  const result = await client.post('/articles/draft', body);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

// ─── publish ────────────────────────────────────────────────────────────────

/**
 * POST /2/articles/{article_id}/publish — publish a draft Article.
 * Auth: write (user context, Premium required).
 * Accepts `--id <article_id>` or a bare positional.
 */
async function publish(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { id: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });

  if (values['id'] && positionals.length > 0) {
    throw new UsageError('--id and a positional article ID are mutually exclusive');
  }
  const id = values['id'] ?? positionals[0];
  if (!id) throw new UsageError('--id (or an article id positional) is required');

  const result = await client.post(
    `/articles/${encodeURIComponent(id)}/publish`,
    {},
  );
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}
