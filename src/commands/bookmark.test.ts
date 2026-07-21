import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import type { XClientConfig } from '../types.js';
import { runBookmark, BOOKMARK_HELP } from './bookmark.js';

// Bookmarks are OAuth 2.0-only — the config carries an oauth2 user token.
const CFG: XClientConfig = {
  oauth2AccessToken: 'OAUTH2_USERTOKEN_ABCD1234',
  baseUrl: 'https://api.x.com/2',
};

const makeClient = (): XClient => new XClient(CFG);

const mockFetch = (body: unknown, status = 200): ReturnType<typeof vi.fn> =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

describe('runBookmark', () => {
  let out: MockInstance;

  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  // ─── dispatch ────────────────────────────────────────────────────────────
  it('throws UsageError on unknown sub-action', async () => {
    await expect(runBookmark(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError with no sub-action', async () => {
    await expect(runBookmark(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });

  // ─── HELP notes OAuth 2.0-only ─────────────────────────────────────────────
  it('HELP text notes OAuth 2.0-only', () => {
    expect(BOOKMARK_HELP).toContain('OAuth 2.0');
  });

  // ─── list ──────────────────────────────────────────────────────────────────
  describe('list', () => {
    it('throws UsageError without --id', async () => {
      await expect(runBookmark(makeClient(), ['list'], CFG)).rejects.toThrow(UsageError);
    });

    it('GETs /users/{id}/bookmarks (single page)', async () => {
      const fetchMock = mockFetch({
        data: [{ id: '20', text: 'bookmarked tweet' }],
        meta: { result_count: 1 },
      });
      vi.stubGlobal('fetch', fetchMock);

      await runBookmark(makeClient(), ['list', '--id', '111'], CFG);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('https://api.x.com/2/users/111/bookmarks');
      expect(init.method).toBe('GET');
      const written = out.mock.calls.flat().join('');
      expect(written).toContain('bookmarked tweet');
      expect(written).toMatch(/\n$/);
    });

    it('passes field flags through as query params', async () => {
      const fetchMock = mockFetch({ data: [], meta: {} });
      vi.stubGlobal('fetch', fetchMock);

      await runBookmark(
        makeClient(),
        ['list', '--id', '111', '--tweet-fields', 'created_at', '--max-results', '50'],
        CFG,
      );

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('tweet.fields=created_at');
      expect(url).toContain('max_results=50');
    });

    it('--all follows the next_token cursor via pagination_token', async () => {
      const fetchMock = vi
        .fn()
        // page 1 → has a next_token
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'CURSOR2' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        // page 2 → no next_token → stop
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: '2' }], meta: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await runBookmark(makeClient(), ['list', '--id', '111', '--all'], CFG);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url2] = fetchMock.mock.calls[1] as [string];
      expect(url2).toContain('pagination_token=CURSOR2');

      // Accumulated items from BOTH pages are printed.
      const written = out.mock.calls.flat().join('');
      expect(written).toContain('"1"');
      expect(written).toContain('"2"');
    });
  });

  // ─── add ─────────────────────────────────────────────────────────────────
  describe('add', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runBookmark(makeClient(), ['add', '--tweet-id', '20'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --tweet-id', async () => {
      await expect(
        runBookmark(makeClient(), ['add', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('POSTs /users/{id}/bookmarks with {tweet_id} body', async () => {
      const fetchMock = mockFetch({ data: { bookmarked: true } });
      vi.stubGlobal('fetch', fetchMock);

      await runBookmark(
        makeClient(),
        ['add', '--user-id', '111', '--tweet-id', '20'],
        CFG,
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/bookmarks');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ tweet_id: '20' });
      expect(out.mock.calls.flat().join('')).toContain('bookmarked');
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────
  describe('remove', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runBookmark(makeClient(), ['remove', '--tweet-id', '20'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --tweet-id', async () => {
      await expect(
        runBookmark(makeClient(), ['remove', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('DELETEs /users/{id}/bookmarks/{tweet_id}', async () => {
      const fetchMock = mockFetch({ data: { bookmarked: false } });
      vi.stubGlobal('fetch', fetchMock);

      await runBookmark(
        makeClient(),
        ['remove', '--user-id', '111', '--tweet-id', '20'],
        CFG,
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/bookmarks/20');
      expect(init.method).toBe('DELETE');
      expect(out.mock.calls.flat().join('')).toContain('bookmarked');
    });
  });

  // ─── redaction ─────────────────────────────────────────────────────────────
  it('redacts the user token from stdout', async () => {
    const fetchMock = mockFetch({
      data: { bookmarked: true, note: `leaked-${CFG.oauth2AccessToken}` },
    });
    vi.stubGlobal('fetch', fetchMock);

    await runBookmark(
      makeClient(),
      ['add', '--user-id', '111', '--tweet-id', '20'],
      CFG,
    );

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(CFG.oauth2AccessToken);
    expect(written).toContain('[REDACTED]');
  });
});
