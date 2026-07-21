import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runRetweet } from './retweet.js';
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

describe('runRetweet dispatch', () => {
  it('throws UsageError on unknown subcommand', async () => {
    await expect(runRetweet(makeClient(), ['xyz'], CFG)).rejects.toThrow(UsageError);
  });
  it('throws UsageError with no subcommand', async () => {
    await expect(runRetweet(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── create ─────────────────────────────────────────────────────────────────────

describe('runRetweet create', () => {
  it('throws UsageError without --user-id', async () => {
    await expect(
      runRetweet(makeClient(), ['create', '--tweet-id', '20'], CFG),
    ).rejects.toThrow(UsageError);
  });
  it('throws UsageError without --tweet-id', async () => {
    await expect(
      runRetweet(makeClient(), ['create', '--user-id', '99'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs /users/{id}/retweets with {tweet_id} body', async () => {
    const fetchMock = mockFetch({ data: { retweeted: true } });
    vi.stubGlobal('fetch', fetchMock);
    await runRetweet(makeClient(), ['create', '--user-id', '99', '--tweet-id', '20'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/99/retweets');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['tweet_id']).toBe('20');
    expect(written()).toContain('retweeted');
  });

  it('redacts secrets in create output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: { retweeted: true, echo: BEARER } }));
    await runRetweet(makeClient(), ['create', '--user-id', '99', '--tweet-id', '20'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

// ─── delete (maps --tweet-id → source_tweet_id) ──────────────────────────────────

describe('runRetweet delete', () => {
  it('throws UsageError without --user-id', async () => {
    await expect(
      runRetweet(makeClient(), ['delete', '--tweet-id', '20'], CFG),
    ).rejects.toThrow(UsageError);
  });
  it('throws UsageError without --tweet-id', async () => {
    await expect(
      runRetweet(makeClient(), ['delete', '--user-id', '99'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('DELETEs /users/{id}/retweets/{source_tweet_id}', async () => {
    const fetchMock = mockFetch({ data: { retweeted: false } });
    vi.stubGlobal('fetch', fetchMock);
    await runRetweet(makeClient(), ['delete', '--user-id', '99', '--tweet-id', '20'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // --tweet-id maps to the source_tweet_id path segment
    expect(url).toContain('/users/99/retweets/20');
    expect(init.method).toBe('DELETE');
    expect(written()).toContain('retweeted');
  });
});

// ─── retweeted-by (read, paginated) ──────────────────────────────────────────────

describe('runRetweet retweeted-by', () => {
  it('throws UsageError without --id', async () => {
    await expect(runRetweet(makeClient(), ['retweeted-by'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/{id}/retweeted_by', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runRetweet(makeClient(), ['retweeted-by', '--id', '20'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tweets/20/retweeted_by');
    expect(init.method).toBe('GET');
    const parsed = JSON.parse(written()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('follows pagination with --all sending pagination_token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'RT2' } }),
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
    await runRetweet(makeClient(), ['retweeted-by', '--id', '20', '--all'], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toContain('pagination_token=RT2');
  });

  it('redacts secrets in retweeted-by output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: '1', note: BEARER }], meta: {} }));
    await runRetweet(makeClient(), ['retweeted-by', '--id', '20'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

// ─── quote-tweets (read, --exclude, paginated) ──────────────────────────────────

describe('runRetweet quote-tweets', () => {
  it('throws UsageError without --id', async () => {
    await expect(runRetweet(makeClient(), ['quote-tweets'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/{id}/quote_tweets', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1', text: 'quote' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runRetweet(makeClient(), ['quote-tweets', '--id', '20'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tweets/20/quote_tweets');
    expect(written()).toContain('quote');
  });

  it('passes --exclude as a query param', async () => {
    const fetchMock = mockFetch({ data: [], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runRetweet(
      makeClient(),
      ['quote-tweets', '--id', '20', '--exclude', 'replies,retweets'],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('exclude=replies,retweets');
  });

  it('passes --tweet-fields as a query param', async () => {
    const fetchMock = mockFetch({ data: [], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runRetweet(
      makeClient(),
      ['quote-tweets', '--id', '20', '--tweet-fields', 'created_at'],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('tweet.fields=created_at');
  });
});
