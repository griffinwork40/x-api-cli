import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runSearch } from './search.js';
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

// Precise-typed stdout spy (a factory so `ReturnType<typeof spyStdout>` infers the
// exact MockInstance, avoiding the process.stdout.write-overload vs. vi.spyOn
// generic-default mismatch that a bare `ReturnType<typeof vi.spyOn>` annotation hits).
const spyStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('runSearch dispatch', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError on an unknown sub-action', async () => {
    await expect(runSearch(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError on no sub-action', async () => {
    await expect(runSearch(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── recent ───────────────────────────────────────────────────────────────────

describe('runSearch recent', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --query', async () => {
    await expect(runSearch(makeClient(), ['recent'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/search/recent with the query + options', async () => {
    const fetchMock = mockFetch({
      data: [{ id: '1', text: 'hi' }],
      meta: { result_count: 1 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(
      makeClient(),
      [
        'recent',
        '--query', 'python lang:en',
        '--max-results', '100',
        '--sort-order', 'recency',
        '--since-id', '111',
      ],
      CFG,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // URLSearchParams encodes spaces as '+' (application/x-www-form-urlencoded),
    // which decodeURIComponent leaves intact — assert on the on-the-wire form.
    const decoded = decodeURIComponent(url);
    expect(url).toContain('/tweets/search/recent');
    expect(init.method).toBe('GET');
    expect(decoded).toContain('query=python+lang:en');
    expect(decoded).toContain('max_results=100');
    expect(decoded).toContain('sort_order=recency');
    expect(decoded).toContain('since_id=111');
    expect(out.mock.calls.flat().join('')).toContain('hi');
  });

  it('throws UsageError for a non-positive --max-results', async () => {
    await expect(
      runSearch(makeClient(), ['recent', '--query', 'x', '--max-results', '0'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('maps field flags to API query keys', async () => {
    const fetchMock = mockFetch({ data: [], meta: {} });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(
      makeClient(),
      ['recent', '--query', 'x', '--tweet-fields', 'created_at', '--expansions', 'author_id'],
      CFG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('tweet.fields=created_at');
    expect(decoded).toContain('expansions=author_id');
  });

  it('paginates with --all, following meta.next_token → pagination_token', async () => {
    // page 1 → next_token 'p2'; page 2 → next_token 'p3'; page 3 → no token (stop).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'p2' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: '2' }], meta: { next_token: 'p3' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: '3' }], meta: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['recent', '--query', 'x', '--all'], CFG);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // page 1 sends no pagination_token; page 2 sends p2; page 3 sends p3.
    const url1 = decodeURIComponent((fetchMock.mock.calls[0] as [string])[0]);
    const url2 = decodeURIComponent((fetchMock.mock.calls[1] as [string])[0]);
    const url3 = decodeURIComponent((fetchMock.mock.calls[2] as [string])[0]);
    expect(url1).not.toContain('pagination_token');
    expect(url2).toContain('pagination_token=p2');
    expect(url3).toContain('pagination_token=p3');

    // Accumulated data across all pages is printed.
    const written = out.mock.calls.flat().join('');
    expect(written).toContain('"id": "1"');
    expect(written).toContain('"id": "2"');
    expect(written).toContain('"id": "3"');
  });

  it('caps pages with --max-pages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'x' }], meta: { next_token: 'always' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['recent', '--query', 'x', '--max-pages', '2'], CFG);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1', text: `leak ${SECRET}` }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['recent', '--query', 'x'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── all (full-archive) ─────────────────────────────────────────────────────

describe('runSearch all', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --query', async () => {
    await expect(runSearch(makeClient(), ['all'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/search/all', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['all', '--query', 'from:TwitterDev', '--max-results', '500'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/tweets/search/all');
    expect(decodeURIComponent(url)).toContain('max_results=500');
  });
});

// ─── counts ───────────────────────────────────────────────────────────────────

describe('runSearch counts', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --query', async () => {
    await expect(runSearch(makeClient(), ['counts'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/counts/recent by default and prints total_tweet_count', async () => {
    const fetchMock = mockFetch({
      data: [{ start: 's', end: 'e', tweet_count: 4213 }],
      meta: { total_tweet_count: 30122 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['counts', '--query', 'python', '--granularity', 'day'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    const decoded = decodeURIComponent(url);
    expect(url).toContain('/tweets/counts/recent');
    expect(decoded).toContain('query=python');
    expect(decoded).toContain('granularity=day');

    const written = out.mock.calls.flat().join('');
    expect(written).toContain('"total_tweet_count": 30122');
  });

  it('GETs /tweets/counts/all when --all is given', async () => {
    const fetchMock = mockFetch({ data: [], meta: { total_tweet_count: 1 } });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['counts', '--query', 'python', '--all'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/tweets/counts/all');
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({
      data: [{ note: `leak ${SECRET}`, tweet_count: 1 }],
      meta: { total_tweet_count: 1 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch(makeClient(), ['counts', '--query', 'x'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});
