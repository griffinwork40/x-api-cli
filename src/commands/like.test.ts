import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runLike } from './like.js';
import type { XClientConfig } from '../types.js';

const BEARER = 'TESTBEARER_ABCD1234';
const CFG: XClientConfig = { bearerToken: BEARER, baseUrl: 'https://api.x.com/2' };
const makeClient = (): XClient => new XClient(CFG);

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

let out: MockInstance;
beforeEach(() => {
  out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  out.mockRestore();
});
const written = (): string => out.mock.calls.flat().join('');

// ─── dispatch ─────────────────────────────────────────────────────────────────

describe('runLike dispatch', () => {
  it('throws UsageError on unknown subcommand', async () => {
    await expect(runLike(makeClient(), ['nope'], CFG)).rejects.toThrow(UsageError);
  });
  it('throws UsageError with no subcommand', async () => {
    await expect(runLike(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── create ─────────────────────────────────────────────────────────────────────

describe('runLike create', () => {
  it('throws UsageError without --user-id', async () => {
    await expect(
      runLike(makeClient(), ['create', '--tweet-id', '20'], CFG),
    ).rejects.toThrow(UsageError);
  });
  it('throws UsageError without --tweet-id', async () => {
    await expect(
      runLike(makeClient(), ['create', '--user-id', '99'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs /users/{id}/likes with {tweet_id} body', async () => {
    const fetchMock = mockFetch({ data: { liked: true } });
    vi.stubGlobal('fetch', fetchMock);
    await runLike(makeClient(), ['create', '--user-id', '99', '--tweet-id', '20'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/99/likes');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['tweet_id']).toBe('20');
    expect(written()).toContain('liked');
  });

  it('redacts secrets in create output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: { liked: true, echo: BEARER } }));
    await runLike(makeClient(), ['create', '--user-id', '99', '--tweet-id', '20'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

// ─── delete ─────────────────────────────────────────────────────────────────────

describe('runLike delete', () => {
  it('throws UsageError without --user-id', async () => {
    await expect(
      runLike(makeClient(), ['delete', '--tweet-id', '20'], CFG),
    ).rejects.toThrow(UsageError);
  });
  it('throws UsageError without --tweet-id', async () => {
    await expect(
      runLike(makeClient(), ['delete', '--user-id', '99'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('DELETEs /users/{id}/likes/{tweet_id}', async () => {
    const fetchMock = mockFetch({ data: { liked: false } });
    vi.stubGlobal('fetch', fetchMock);
    await runLike(makeClient(), ['delete', '--user-id', '99', '--tweet-id', '20'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/99/likes/20');
    expect(init.method).toBe('DELETE');
    expect(written()).toContain('liked');
  });
});

// ─── liking-users (user context read) ────────────────────────────────────────────

describe('runLike liking-users', () => {
  it('throws UsageError without --id', async () => {
    await expect(runLike(makeClient(), ['liking-users'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/{id}/liking_users', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runLike(makeClient(), ['liking-users', '--id', '20'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tweets/20/liking_users');
    expect(init.method).toBe('GET');
    const parsed = JSON.parse(written()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('passes --user-fields and --max-results', async () => {
    const fetchMock = mockFetch({ data: [], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runLike(
      makeClient(),
      ['liking-users', '--id', '20', '--user-fields', 'username', '--max-results', '100'],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('user.fields=username');
    expect(decoded).toContain('max_results=100');
  });

  it('follows pagination with --all', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'T2' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: '2' }], meta: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await runLike(makeClient(), ['liking-users', '--id', '20', '--all'], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toContain('pagination_token=T2');
  });

  it('redacts secrets in liking-users output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: '1', note: BEARER }], meta: {} }));
    await runLike(makeClient(), ['liking-users', '--id', '20'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

// ─── liked-tweets (user context read) ────────────────────────────────────────────

describe('runLike liked-tweets', () => {
  it('throws UsageError without --id', async () => {
    await expect(runLike(makeClient(), ['liked-tweets'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id}/liked_tweets', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1', text: 'hi' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runLike(makeClient(), ['liked-tweets', '--id', '2244994945'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/2244994945/liked_tweets');
    expect(written()).toContain('hi');
  });
});
