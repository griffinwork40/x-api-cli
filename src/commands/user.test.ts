import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runUser } from './user.js';
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

describe('runUser dispatch', () => {
  it('throws UsageError on unknown subcommand', async () => {
    await expect(runUser(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });
  it('throws UsageError with no subcommand', async () => {
    await expect(runUser(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('runUser get', () => {
  it('throws UsageError when none of --id/--ids/--username/--usernames given', async () => {
    await expect(runUser(makeClient(), ['get'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError when more than one selector is given', async () => {
    await expect(
      runUser(makeClient(), ['get', '--id', '2244994945', '--username', 'X'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id} for --id', async () => {
    const fetchMock = mockFetch({ data: { id: '2244994945', username: 'TwitterDev' } });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['get', '--id', '2244994945'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/2244994945');
    expect(init.method).toBe('GET');
    expect(written()).toContain('TwitterDev');
  });

  it('GETs /users?ids= for --ids', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }, { id: '2' }] });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['get', '--ids', '1,2'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users?');
    expect(decodeURIComponent(url)).toContain('ids=1,2');
  });

  it('GETs /users/by/username/{username} for --username', async () => {
    const fetchMock = mockFetch({ data: { id: '1', username: 'TwitterDev' } });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['get', '--username', 'TwitterDev'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/by/username/TwitterDev');
  });

  it('GETs /users/by?usernames= for --usernames', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }] });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['get', '--usernames', 'TwitterDev,XDevelopers'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/by?');
    expect(decodeURIComponent(url)).toContain('usernames=TwitterDev,XDevelopers');
  });

  it('passes --user-fields and --expansions as query params', async () => {
    const fetchMock = mockFetch({ data: { id: '1' } });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(
      makeClient(),
      ['get', '--id', '1', '--user-fields', 'created_at,verified', '--expansions', 'pinned_tweet_id'],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('user.fields=created_at,verified');
    expect(decoded).toContain('expansions=pinned_tweet_id');
  });

  it('redacts secrets embedded in response data', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: { id: '1', bio: `token=${BEARER}` } }));
    await runUser(makeClient(), ['get', '--id', '1'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

// ─── me ─────────────────────────────────────────────────────────────────────────

describe('runUser me', () => {
  it('GETs /users/me', async () => {
    const fetchMock = mockFetch({ data: { id: '999', username: 'me' } });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['me'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/me');
    expect(init.method).toBe('GET');
    expect(written()).toContain('999');
  });

  it('passes --user-fields', async () => {
    const fetchMock = mockFetch({ data: { id: '999' } });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['me', '--user-fields', 'public_metrics'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('user.fields=public_metrics');
  });
});

// ─── followers / following ──────────────────────────────────────────────────────

describe('runUser followers', () => {
  it('throws UsageError without --id', async () => {
    await expect(runUser(makeClient(), ['followers'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id}/followers (single page by default)', async () => {
    const fetchMock = mockFetch({
      data: [{ id: '1' }, { id: '2' }],
      meta: { result_count: 2, next_token: 'PAGE2' },
    });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['followers', '--id', '2244994945'], CFG);
    // single page (no --all / --max-pages) → exactly one fetch
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/2244994945/followers');
    // output is the accumulated array
    const parsed = JSON.parse(written()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('passes --max-results as max_results query param', async () => {
    const fetchMock = mockFetch({ data: [], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['followers', '--id', '1', '--max-results', '1000'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('max_results=1000');
  });

  it('throws UsageError for invalid --max-results', async () => {
    await expect(
      runUser(makeClient(), ['followers', '--id', '1', '--max-results', '0'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('follows pagination with --all, sending pagination_token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'TOK2' } }),
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
    await runUser(makeClient(), ['followers', '--id', '1', '--all'], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toContain('pagination_token=TOK2');
    const parsed = JSON.parse(written()) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('caps pages with --max-pages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'x' }], meta: { next_token: 'ALWAYS' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['followers', '--id', '1', '--max-pages', '2'], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts secrets in followers output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: '1', note: BEARER }], meta: {} }));
    await runUser(makeClient(), ['followers', '--id', '1'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

describe('runUser following', () => {
  it('GETs /users/{id}/following', async () => {
    const fetchMock = mockFetch({ data: [{ id: '9' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runUser(makeClient(), ['following', '--id', '2244994945'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/2244994945/following');
  });
});
