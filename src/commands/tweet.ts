import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import { addFieldFlags, collectFieldParams, parsePositiveInt, assertOne } from '../utils.js';
import type { XClientConfig } from '../types.js';

export const TWEET_HELP = `x tweet <get|create|delete> [flags]
  get      GET /2/tweets/{id} or /2/tweets?ids=  (read)
             --id <id> | --ids <csv>   (one required)  + field/expansion flags
  create   POST /2/tweets  (write — user context)
             --text <s>
             --reply-to <tweetId>          (reply.in_reply_to_tweet_id)
             --quote <tweetId>             (quote_tweet_id)
             --media-ids <csv>             (media.media_ids[])
             --poll-options <csv> --poll-duration <min>   (poll.options + duration_minutes)
             --reply-settings <following|mentionedUsers|subscribers|verified>
           (require >=1 of text/media/poll/quote; media/poll/quote mutually exclusive)
  delete   DELETE /2/tweets/{id}  (write — user context)
             --id <id>  (or positional)`;

export async function runTweet(
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
    case 'delete':
      return del(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${TWEET_HELP}`);
  }
}

/**
 * GET /2/tweets/{id} (single) or GET /2/tweets?ids= (batch).
 * Auth: read (Bearer OK).
 */
async function get(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
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

  const id = values['id'];
  const ids = values['ids'];
  if (!id && !ids) throw new UsageError('--id or --ids is required');
  if (id && ids) throw new UsageError('--id and --ids are mutually exclusive');

  const path = id ? `/tweets/${encodeURIComponent(id)}` : '/tweets';
  const params = { ids: ids ?? undefined, ...collectFieldParams(values) };

  const result = await client.get(path, params);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

/**
 * POST /2/tweets — create a Post. Auth: write (user context). Success 201.
 *
 * Body assembly:
 *   --text                        → text
 *   --reply-to <id>               → reply.in_reply_to_tweet_id
 *   --quote <id>                  → quote_tweet_id
 *   --media-ids <csv>             → media.media_ids[]
 *   --poll-options <csv>          → poll.options[]  (+ --poll-duration → poll.duration_minutes)
 *   --reply-settings <enum>       → reply_settings
 *
 * Validation: at least one of text/media/poll/quote; and media/poll/quote are
 * mutually exclusive (X rejects combining them).
 */
async function create(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      text: { type: 'string' },
      'reply-to': { type: 'string' },
      quote: { type: 'string' },
      'media-ids': { type: 'string' },
      'poll-options': { type: 'string' },
      'poll-duration': { type: 'string' },
      'reply-settings': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const text = values['text'];
  const replyTo = values['reply-to'];
  const quote = values['quote'];
  const mediaIds = values['media-ids'];
  const pollOptions = values['poll-options'];
  const pollDuration = values['poll-duration'];
  const replySettings = values['reply-settings'];

  const hasMedia = !!mediaIds;
  const hasPoll = !!pollOptions;
  const hasQuote = !!quote;

  // Require at least one content source.
  if (!text && !hasMedia && !hasPoll && !hasQuote) {
    throw new UsageError(
      'at least one of --text, --media-ids, --poll-options, or --quote is required',
    );
  }

  // media / poll / quote are mutually exclusive.
  const attachments = [hasMedia, hasPoll, hasQuote].filter(Boolean).length;
  if (attachments > 1) {
    throw new UsageError('--media-ids, --poll-options, and --quote are mutually exclusive');
  }

  // A poll needs a duration.
  if (hasPoll && !pollDuration) {
    throw new UsageError('--poll-duration is required when --poll-options is given');
  }

  const body: Record<string, unknown> = {};
  if (text) body['text'] = text;
  if (replyTo) body['reply'] = { in_reply_to_tweet_id: replyTo };
  if (hasQuote) body['quote_tweet_id'] = quote;
  if (hasMedia) {
    body['media'] = { media_ids: (mediaIds as string).split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (hasPoll) {
    body['poll'] = {
      options: (pollOptions as string).split(',').map((s) => s.trim()).filter(Boolean),
      duration_minutes: parsePositiveInt(pollDuration as string, '--poll-duration'),
    };
  }
  if (replySettings) body['reply_settings'] = replySettings;

  const result = await client.post('/tweets', body);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}

/**
 * DELETE /2/tweets/{id}. Auth: write (user context). Success 200 {deleted:true}.
 * Accepts `--id <id>` or a bare positional.
 */
async function del(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { id: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });

  const id = values['id'] ?? assertOne(positionals, '--id (or a tweet id positional)');

  const result = await client.delete(`/tweets/${encodeURIComponent(id)}`);
  process.stdout.write(safeStringify(result, collectSecrets(cfg)) + '\n');
}
