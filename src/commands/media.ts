import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import { parsePositiveInt, sleep } from '../utils.js';
import type { XClientConfig, XEnvelope, MediaUploadResult } from '../types.js';

export const MEDIA_HELP = `x media <upload> [flags]   (write — media.write / oauth1)
  upload  --file <path> --category <tweet_image|dm_image|subtitles|tweet_video|amplify_video|..>
          [--media-type <mime>] [--chunked] [--chunk-size <bytes>] [--max-polls <n>]

  Small images/subtitles → one-shot POST /2/media/upload.
  Video / large media / --chunked → INIT → APPEND(*) → FINALIZE → poll STATUS.`;

/** Chunk-size default (~4.5 MB, under the 5 MB APPEND ceiling to leave multipart headroom). */
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024 + 512 * 1024; // 4.5 MiB
/** Files at/above this size auto-switch to the chunked flow even without --chunked. */
const CHUNKED_THRESHOLD = 5 * 1024 * 1024; // 5 MiB
/** Default cap on STATUS polls before giving up. */
const DEFAULT_MAX_POLLS = 20;

export async function runMedia(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'upload':
      return upload(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${MEDIA_HELP}`);
  }
}

function print(data: unknown, cfg: XClientConfig): void {
  process.stdout.write(safeStringify(data, collectSecrets(cfg)) + '\n');
}

/** Unwrap the client's `{ data }` envelope to the MediaUploadResult (may be undefined). */
function dataOf(env: unknown): MediaUploadResult {
  const e = env as XEnvelope<MediaUploadResult> | null | undefined;
  return (e?.data ?? {}) as MediaUploadResult;
}

async function upload(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      file: { type: 'string' },
      'media-type': { type: 'string' },
      category: { type: 'string' },
      chunked: { type: 'boolean' },
      'chunk-size': { type: 'string' },
      'max-polls': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const file = values['file'];
  const category = values['category'];
  if (!file) throw new UsageError('--file is required. ' + MEDIA_HELP);
  if (!category) throw new UsageError('--category is required. ' + MEDIA_HELP);

  const mediaType = values['media-type'];
  const chunkSize = values['chunk-size']
    ? parsePositiveInt(values['chunk-size'], '--chunk-size')
    : DEFAULT_CHUNK_SIZE;
  const maxPolls = values['max-polls']
    ? parsePositiveInt(values['max-polls'], '--max-polls')
    : DEFAULT_MAX_POLLS;

  // Read the file (stubbed in tests — never a real file there).
  const buffer = readFileSync(file);
  const totalBytes = buffer.length;

  const wantsChunked =
    Boolean(values['chunked']) ||
    totalBytes >= CHUNKED_THRESHOLD ||
    (typeof mediaType === 'string' && mediaType.startsWith('video/'));

  if (!wantsChunked) {
    await oneShot(client, cfg, buffer, category, mediaType);
    return;
  }

  await chunked(client, cfg, buffer, {
    category,
    mediaType,
    totalBytes,
    chunkSize,
    maxPolls,
  });
}

/**
 * Wraps raw bytes in a `Blob` for a multipart `media` field. The X API only reads the
 * bytes (Content-Type on the part is irrelevant), so a generic type is fine; callers may
 * pass a MIME type when known.
 */
function mediaBlob(bytes: Uint8Array, mimeType?: string): Blob {
  // Copy into a fresh Uint8Array so a Buffer subarray's shared ArrayBuffer isn't sent whole.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return mimeType ? new Blob([copy], { type: mimeType }) : new Blob([copy]);
}

// ─── one-shot (images / subtitles) ──────────────────────────────────────────────

async function oneShot(
  client: XClient,
  cfg: XClientConfig,
  buffer: Buffer,
  category: string,
  mediaType: string | undefined,
): Promise<void> {
  // Real multipart/form-data: `media` (file Blob) + `media_category` (+ optional media_type).
  // The client's postMultipart lets fetch set the boundary; OAuth1 signs query params only.
  const form = new FormData();
  form.append('media', mediaBlob(buffer, mediaType), 'media');
  form.append('media_category', category);
  if (mediaType !== undefined) form.append('media_type', mediaType);

  const env = await client.postMultipart('/media/upload', form);
  const data = dataOf(env);
  print({ id: data.id, media_key: data.media_key }, cfg);
}

// ─── chunked (video / large media): INIT → APPEND(*) → FINALIZE → STATUS ─────────

interface ChunkedOpts {
  category: string;
  mediaType: string | undefined;
  totalBytes: number;
  chunkSize: number;
  maxPolls: number;
}

async function chunked(
  client: XClient,
  cfg: XClientConfig,
  buffer: Buffer,
  opts: ChunkedOpts,
): Promise<void> {
  // ── Step 1: INIT (JSON) → media_id ──
  const initBody: Record<string, unknown> = {
    total_bytes: opts.totalBytes,
    media_category: opts.category,
  };
  if (opts.mediaType !== undefined) initBody['media_type'] = opts.mediaType;

  const initEnv = await client.post('/media/upload/initialize', initBody);
  const mediaId = dataOf(initEnv).id;
  if (!mediaId) {
    throw new UsageError('media INIT did not return a media id');
  }

  // ── Step 2: APPEND loop (one call per chunk, segment_index 0-based) ──
  // Each APPEND is multipart/form-data: `media` (binary chunk Blob) + `segment_index`.
  let segmentIndex = 0;
  for (let offset = 0; offset < opts.totalBytes; offset += opts.chunkSize) {
    const chunk = buffer.subarray(offset, Math.min(offset + opts.chunkSize, opts.totalBytes));
    const form = new FormData();
    form.append('media', mediaBlob(chunk, opts.mediaType), 'media');
    form.append('segment_index', String(segmentIndex));
    await client.postMultipart(`/media/upload/${mediaId}/append`, form);
    segmentIndex += 1;
  }

  // ── Step 3: FINALIZE ──
  const finalizeEnv = await client.post(`/media/upload/${mediaId}/finalize`);
  let data = dataOf(finalizeEnv);

  // ── Step 4: poll STATUS until succeeded/failed (respect check_after_secs, cap polls) ──
  let processing = data.processing_info as
    | { state?: string; check_after_secs?: number }
    | undefined;

  let polls = 0;
  while (processing && (processing.state === 'pending' || processing.state === 'in_progress')) {
    if (polls >= opts.maxPolls) {
      throw new UsageError(
        `media processing did not finish after ${opts.maxPolls} status polls (still '${processing.state}')`,
      );
    }
    const waitSecs = typeof processing.check_after_secs === 'number' ? processing.check_after_secs : 1;
    await sleep(waitSecs * 1000);
    polls += 1;

    const statusEnv = await client.get('/media/upload', { media_id: mediaId });
    data = dataOf(statusEnv);
    processing = data.processing_info as
      | { state?: string; check_after_secs?: number }
      | undefined;
  }

  if (processing && processing.state === 'failed') {
    throw new UsageError(`media processing failed: ${JSON.stringify(processing)}`);
  }

  print(
    { id: data.id ?? mediaId, media_key: data.media_key, processing_info: data.processing_info },
    cfg,
  );
}
