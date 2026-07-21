import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runTimeline } from './timeline.js';
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

describe('runTimeline dispatch', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError on an unknown sub-action', async () => {
    await expect(runTimeline(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError on no sub-action', async () => {
    await expect(runTimeline(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── posts ────────────────────────────────────────────────────────────────────

describe('runTimeline posts', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runTimeline(makeClient(), ['posts'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id}/tweets with options + --exclude', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1', text: 'hi' }], meta: { result_count: 1 } });
    vi.stubGlobal('fetch', fetchMock);

    await runTimeline(
      makeClient(),
      ['posts', '--id', '2244994945', '--max-results', '100', '--exclude', 'retweets,replies'],
      CFG,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(url).toContain('/users/2244994945/tweets');
    expect(init.method).toBe('GET');
    expect(decoded).toContain('max_results=100');
    expect(decoded).toContain('exclude=retweets,replies');
    expect(out.mock.calls.flat().join('')).toContain('hi');
  });

  it('throws UsageError for a non-positive --max-results', async () => {
    await expect(
      runTimeline(makeClient(), ['posts', '--id', '1', '--max-results', '0'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('paginates with --all following meta.next_token → pagination_token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'n2' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: '2' }], meta: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await runTimeline(makeClient(), ['posts', '--id', '1', '--all'], CFG);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url1 = decodeURIComponent((fetchMock.mock.calls[0] as [string])[0]);
    const url2 = decodeURIComponent((fetchMock.mock.calls[1] as [string])[0]);
    expect(url1).not.toContain('pagination_token');
    expect(url2).toContain('pagination_token=n2');

    const written = out.mock.calls.flat().join('');
    expect(written).toContain('"id": "1"');
    expect(written).toContain('"id": "2"');
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1', text: `leak ${SECRET}` }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);

    await runTimeline(makeClient(), ['posts', '--id', '1'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── mentions ───────────────────────────────────────────────────────────────

describe('runTimeline mentions', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runTimeline(makeClient(), ['mentions'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id}/mentions', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);

    await runTimeline(makeClient(), ['mentions', '--id', '2244994945'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/users/2244994945/mentions');
  });

  it('rejects --exclude (not a valid flag for mentions, strict parseArgs)', async () => {
    await expect(
      runTimeline(makeClient(), ['mentions', '--id', '1', '--exclude', 'replies'], CFG),
    ).rejects.toThrow();
  });
});

// ─── home ───────────────────────────────────────────────────────────────────

describe('runTimeline home', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runTimeline(makeClient(), ['home'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id}/timelines/reverse_chronological', async () => {
    const fetchMock = mockFetch({ data: [{ id: '1' }], meta: {} });
    vi.stubGlobal('fetch', fetchMock);

    await runTimeline(makeClient(), ['home', '--id', '2244994945'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/users/2244994945/timelines/reverse_chronological');
  });
});
