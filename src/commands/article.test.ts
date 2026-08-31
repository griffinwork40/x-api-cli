import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub node:fs/promises BEFORE importing the module under test so `readFile` is the mock.
let mockFileContent = '{}';
let mockFileError: Error | null = null;
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(() => {
    if (mockFileError) return Promise.reject(mockFileError);
    return Promise.resolve(mockFileContent);
  }),
}));

import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runArticle } from './article.js';
import type { XClientConfig } from '../types.js';

const SECRET = 'TESTBEARER_ABCD1234';
const CFG: XClientConfig = {
  bearerToken: SECRET,
  baseUrl: 'https://api.x.com/2',
  authMode: 'bearer',
};
const makeClient = (): XClient => new XClient(CFG);

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const spyStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// ─── dispatch ──────────────────────────────────────────────────────────────

describe('runArticle dispatch', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => { out = spyStdout(); });
  afterEach(() => { vi.unstubAllGlobals(); out.mockRestore(); });

  it('throws UsageError on an unknown sub-action', async () => {
    await expect(runArticle(makeClient(), ['frobnicate'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError on no sub-action', async () => {
    await expect(runArticle(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── draft ─────────────────────────────────────────────────────────────────

describe('runArticle draft', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
    mockFileContent = '{}';
    mockFileError = null;
  });
  afterEach(() => { vi.unstubAllGlobals(); out.mockRestore(); });

  it('throws UsageError without --title', async () => {
    await expect(
      runArticle(makeClient(), ['draft', '--content-json', '{"blocks":[]}'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError without content flags', async () => {
    await expect(
      runArticle(makeClient(), ['draft', '--title', 'Test'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError when both --content-file and --content-json given', async () => {
    await expect(
      runArticle(
        makeClient(),
        ['draft', '--title', 'T', '--content-file', 'f.json', '--content-json', '{}'],
        CFG,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError on invalid --content-json', async () => {
    await expect(
      runArticle(makeClient(), ['draft', '--title', 'T', '--content-json', 'not json'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError when --content-file has invalid JSON', async () => {
    mockFileContent = 'not json';
    await expect(
      runArticle(makeClient(), ['draft', '--title', 'T', '--content-file', 'bad.json'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs /articles/draft with --content-json', async () => {
    const fetchMock = mockFetch({ data: { article_id: '123' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    const contentState = JSON.stringify({ blocks: [{ text: 'Hello', key: 'a1' }], entities: [] });
    await runArticle(
      makeClient(),
      ['draft', '--title', 'My Article', '--content-json', contentState],
      CFG,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/articles/draft');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['title']).toBe('My Article');
    expect(body['content_state']).toEqual({ blocks: [{ text: 'Hello', key: 'a1' }], entities: [] });
  });

  it('POSTs /articles/draft with --content-file', async () => {
    const contentState = { blocks: [{ text: 'From file', key: 'b1' }], entities: [] };
    mockFileContent = JSON.stringify(contentState);
    const fetchMock = mockFetch({ data: { article_id: '456' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runArticle(
      makeClient(),
      ['draft', '--title', 'File Article', '--content-file', 'article.json'],
      CFG,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/articles/draft');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['title']).toBe('File Article');
    expect(body['content_state']).toEqual(contentState);
  });

  it('includes cover_media when --cover-media-id is given', async () => {
    const fetchMock = mockFetch({ data: { article_id: '789' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runArticle(
      makeClient(),
      ['draft', '--title', 'Cover', '--content-json', '{"blocks":[]}', '--cover-media-id', 'M1'],
      CFG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['cover_media']).toEqual({ media_id: 'M1' });
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({ data: { article_id: '1', note: SECRET } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runArticle(
      makeClient(),
      ['draft', '--title', 'T', '--content-json', '{"blocks":[]}'],
      CFG,
    );

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── publish ────────────────────────────────────────────────────────────────

describe('runArticle publish', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => { out = spyStdout(); });
  afterEach(() => { vi.unstubAllGlobals(); out.mockRestore(); });

  it('throws UsageError without an id', async () => {
    await expect(runArticle(makeClient(), ['publish'], CFG)).rejects.toThrow(UsageError);
  });

  it('POSTs /articles/{id}/publish via --id', async () => {
    const fetchMock = mockFetch({ data: { post_id: '999' } });
    vi.stubGlobal('fetch', fetchMock);

    await runArticle(makeClient(), ['publish', '--id', '123'], CFG);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/articles/123/publish');
    expect(init.method).toBe('POST');
    expect(out.mock.calls.flat().join('')).toContain('post_id');
  });

  it('POSTs /articles/{id}/publish via positional', async () => {
    const fetchMock = mockFetch({ data: { post_id: '888' } });
    vi.stubGlobal('fetch', fetchMock);

    await runArticle(makeClient(), ['publish', '456'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/articles/456/publish');
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({ data: { post_id: '1', leak: SECRET } });
    vi.stubGlobal('fetch', fetchMock);

    await runArticle(makeClient(), ['publish', '1'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});
