import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Stub node:fs BEFORE importing the module under test so `readFileSync` is the mock.
// The returned buffer size is controlled per-test via `setFileBytes`.
let fileBytes = 8; // default tiny → one-shot path
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => Buffer.alloc(fileBytes, 1)),
}));
function setFileBytes(n: number): void {
  fileBytes = n;
}

import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runMedia } from './media.js';
import type { XClientConfig } from '../types.js';

// Media is an oauth1 write surface; use oauth1 creds so redaction covers those secrets.
const CFG: XClientConfig = {
  oauth1: {
    apiKey: 'CK_TEST_1234',
    apiSecret: 'CS_TEST_SECRET_5678',
    accessToken: 'AT_TEST_9012',
    accessTokenSecret: 'ATS_TEST_SECRET_3456',
  },
  baseUrl: 'https://api.x.com/2',
  authMode: 'oauth1',
};
const makeClient = (): XClient => new XClient(CFG);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Typed accessor for one recorded fetch call (`[url, init]`), guarded for noUncheckedIndexedAccess. */
function callAt(fetchMock: ReturnType<typeof vi.fn>, i: number): [string, RequestInit] {
  const call = fetchMock.mock.calls[i];
  if (!call) throw new Error(`expected a fetch call at index ${i}`);
  return call as [string, RequestInit];
}

beforeEach(() => {
  setFileBytes(8);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── dispatch ───────────────────────────────────────────────────────────────────

describe('runMedia dispatch', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => out.mockRestore());

  it('throws UsageError on unknown subcommand', async () => {
    await expect(runMedia(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── required-flag validation ─────────────────────────────────────────────────

describe('runMedia upload validation', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => out.mockRestore());

  it('throws UsageError without --file', async () => {
    await expect(
      runMedia(makeClient(), ['upload', '--category', 'tweet_image'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError without --category', async () => {
    await expect(
      runMedia(makeClient(), ['upload', '--file', '/tmp/x.png'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError for invalid --chunk-size', async () => {
    await expect(
      runMedia(
        makeClient(),
        ['upload', '--file', '/tmp/x.png', '--category', 'tweet_image', '--chunk-size', '0'],
        CFG,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError for invalid --max-polls', async () => {
    await expect(
      runMedia(
        makeClient(),
        ['upload', '--file', '/tmp/x.png', '--category', 'tweet_image', '--max-polls', 'abc'],
        CFG,
      ),
    ).rejects.toThrow(UsageError);
  });
});

// ─── one-shot (small image) — real multipart/form-data ──────────────────────────

describe('runMedia upload — one-shot', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => out.mockRestore());

  it('POSTs multipart /media/upload once (media + media_category) and prints {id, media_key}', async () => {
    setFileBytes(1024); // small → one-shot
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { id: '1146654567674912769', media_key: '3_1146654567674912769' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runMedia(
      makeClient(),
      ['upload', '--file', '/tmp/photo.png', '--category', 'tweet_image'],
      CFG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = callAt(fetchMock, 0);
    expect(url).toBe('https://api.x.com/2/media/upload');
    expect(init.method).toBe('POST');

    // Body is a real FormData, NOT a JSON string — assert multipart usage.
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('media_category')).toBe('tweet_image');
    // `media` is a Blob-ish file part carrying the bytes (size = the stubbed 1024).
    const mediaPart = form.get('media');
    expect(mediaPart).not.toBeNull();
    expect(mediaPart).toBeInstanceOf(Blob);
    expect((mediaPart as Blob).size).toBe(1024);

    // fetch must NOT be told a Content-Type — it derives the multipart boundary itself.
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();
    // OAuth1 signs query params only → an Authorization: OAuth header must be present.
    expect(String(headers['Authorization'])).toMatch(/^OAuth /);

    const written = out.mock.calls.flat().join('');
    expect(written).toContain('1146654567674912769');
    expect(written).toContain('3_1146654567674912769');
  });

  it('forwards --media-type as a form field when provided', async () => {
    setFileBytes(256);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: '2', media_key: 'k2' } }));
    vi.stubGlobal('fetch', fetchMock);

    await runMedia(
      makeClient(),
      ['upload', '--file', '/tmp/photo.png', '--category', 'tweet_image', '--media-type', 'image/png'],
      CFG,
    );

    const [, init] = callAt(fetchMock, 0);
    const form = init.body as FormData;
    expect(form.get('media_type')).toBe('image/png');
  });

  it('redacts a secret leaked in response data', async () => {
    setFileBytes(512);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ data: { id: '1', media_key: CFG.oauth1?.apiSecret } }),
      ),
    );
    await runMedia(
      makeClient(),
      ['upload', '--file', '/tmp/x.png', '--category', 'tweet_image'],
      CFG,
    );
    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(CFG.oauth1?.apiSecret as string);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── chunked (video / large / --chunked): INIT → APPEND(*) → FINALIZE → STATUS ──

describe('runMedia upload — chunked', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => out.mockRestore());

  it('runs INIT→APPEND×N→FINALIZE→STATUS in order (JSON INIT/FINALIZE, multipart APPEND, 0-based segments)', async () => {
    // 25 bytes with 10-byte chunks → 3 APPEND calls (0,1,2).
    setFileBytes(25);
    const MEDIA_ID = '7_999';

    const fetchMock = vi
      .fn()
      // INIT
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, media_key: '7_key', expires_after_secs: 86400 } }))
      // APPEND 0,1,2 (empty 2xx)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // FINALIZE → processing pending, poll needed
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'pending', check_after_secs: 0 } } }))
      // STATUS → succeeded
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, media_key: '7_key', processing_info: { state: 'succeeded', progress_percent: 100 } } }));
    vi.stubGlobal('fetch', fetchMock);

    await runMedia(
      makeClient(),
      [
        'upload',
        '--file', '/tmp/video.mp4',
        '--category', 'tweet_video',
        '--media-type', 'video/mp4',
        '--chunked',
        '--chunk-size', '10',
        '--max-polls', '5',
      ],
      CFG,
    );

    expect(fetchMock.mock.calls).toHaveLength(6);

    // 1) INIT — JSON body.
    const init0 = callAt(fetchMock, 0);
    expect(init0[0]).toBe('https://api.x.com/2/media/upload/initialize');
    expect(init0[1].method).toBe('POST');
    expect(init0[1].body).not.toBeInstanceOf(FormData);
    const initBody = JSON.parse(init0[1].body as string) as Record<string, unknown>;
    expect(initBody).toMatchObject({
      media_type: 'video/mp4',
      total_bytes: 25,
      media_category: 'tweet_video',
    });

    // 2-4) APPEND — multipart with segment_index 0,1,2 and a `media` Blob part.
    for (let i = 0; i < 3; i++) {
      const [url, init] = callAt(fetchMock, 1 + i);
      expect(url).toBe(`https://api.x.com/2/media/upload/${MEDIA_ID}/append`);
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('segment_index')).toBe(String(i));
      expect(form.get('media')).toBeInstanceOf(Blob);
    }

    // 5) FINALIZE — POST, no multipart.
    const fin = callAt(fetchMock, 4);
    expect(fin[0]).toBe(`https://api.x.com/2/media/upload/${MEDIA_ID}/finalize`);
    expect(fin[1].method).toBe('POST');

    // 6) STATUS — GET with media_id query.
    const stat = callAt(fetchMock, 5);
    expect(stat[0]).toContain('https://api.x.com/2/media/upload?');
    expect(stat[0]).toContain(`media_id=${MEDIA_ID}`);
    expect(stat[1].method).toBe('GET');

    const written = out.mock.calls.flat().join('');
    expect(written).toContain(MEDIA_ID);
    expect(written).toContain('succeeded');
    expect(written).toContain('processing_info');
  });

  it('auto-selects chunked when the file exceeds the size threshold (no --chunked flag)', async () => {
    // 6 MiB with the default ~4.5 MiB chunk = 2 APPENDs.
    // Sequence: INIT, APPEND 0, APPEND 1, FINALIZE (no processing_info → no polling).
    setFileBytes(6 * 1024 * 1024); // > 5 MiB threshold
    const MEDIA_ID = '7_big';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID } })) // INIT
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // APPEND 0
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // APPEND 1
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, media_key: '7_bigkey' } })); // FINALIZE, no processing_info
    vi.stubGlobal('fetch', fetchMock);

    await runMedia(
      makeClient(),
      ['upload', '--file', '/tmp/big.mp4', '--category', 'tweet_video'],
      CFG,
    );

    // INIT + 2 APPEND + FINALIZE = 4 (no STATUS because FINALIZE had no processing_info)
    expect(fetchMock.mock.calls).toHaveLength(4);
    expect(callAt(fetchMock, 0)[0]).toContain('/media/upload/initialize');
    const append0 = callAt(fetchMock, 1);
    expect(append0[0]).toContain(`/media/upload/${MEDIA_ID}/append`);
    expect(append0[1].body).toBeInstanceOf(FormData);
    expect(callAt(fetchMock, 3)[0]).toContain(`/media/upload/${MEDIA_ID}/finalize`);
    const written = out.mock.calls.flat().join('');
    expect(written).toContain('7_bigkey');
  });

  it('polls STATUS repeatedly until succeeded', async () => {
    setFileBytes(10);
    const MEDIA_ID = '7_poll';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID } })) // INIT
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // APPEND 0 (10 bytes, 20-byte chunk → 1 append)
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'pending', check_after_secs: 0 } } })) // FINALIZE
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'in_progress', check_after_secs: 0, progress_percent: 50 } } })) // STATUS 1
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'succeeded', progress_percent: 100 } } })); // STATUS 2
    vi.stubGlobal('fetch', fetchMock);

    await runMedia(
      makeClient(),
      ['upload', '--file', '/tmp/v.mp4', '--category', 'tweet_video', '--chunked', '--chunk-size', '20', '--max-polls', '5'],
      CFG,
    );

    // INIT + 1 APPEND + FINALIZE + 2 STATUS = 5
    expect(fetchMock.mock.calls).toHaveLength(5);
    expect(callAt(fetchMock, 3)[0]).toContain('media_id=' + MEDIA_ID); // first STATUS
    expect(callAt(fetchMock, 4)[0]).toContain('media_id=' + MEDIA_ID); // second STATUS
    const written = out.mock.calls.flat().join('');
    expect(written).toContain('succeeded');
  });

  it('throws UsageError when polling exhausts --max-polls without finishing', async () => {
    setFileBytes(10);
    const MEDIA_ID = '7_stuck';
    // INIT, APPEND, FINALIZE(pending), then STATUS always in_progress → exhaust max-polls=2.
    // NB: a Response body can only be read once, so STATUS must return a FRESH Response each call
    // (use a factory, not a single shared mockResolvedValue).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID } })) // INIT
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // APPEND
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'pending', check_after_secs: 0 } } })) // FINALIZE
      .mockImplementation(async () =>
        jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'in_progress', check_after_secs: 0 } } }),
      ); // STATUS always in_progress (fresh Response per poll)
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runMedia(
        makeClient(),
        ['upload', '--file', '/tmp/v.mp4', '--category', 'tweet_video', '--chunked', '--chunk-size', '20', '--max-polls', '2'],
        CFG,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError when media processing reports failed', async () => {
    setFileBytes(10);
    const MEDIA_ID = '7_fail';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID } })) // INIT
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // APPEND
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'pending', check_after_secs: 0 } } })) // FINALIZE
      .mockResolvedValueOnce(jsonResponse({ data: { id: MEDIA_ID, processing_info: { state: 'failed', error: { message: 'bad' } } } })); // STATUS failed
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runMedia(
        makeClient(),
        ['upload', '--file', '/tmp/v.mp4', '--category', 'tweet_video', '--chunked', '--chunk-size', '20'],
        CFG,
      ),
    ).rejects.toThrow(UsageError);
  });
});
