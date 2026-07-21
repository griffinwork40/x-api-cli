import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import type { XClientConfig } from '../types.js';
import { runFollow } from './follow.js';

// A user-context config (writes require user context; oauth2 token here).
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

describe('runFollow', () => {
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
    await expect(runFollow(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError with no sub-action', async () => {
    await expect(runFollow(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });

  // ─── follow ──────────────────────────────────────────────────────────────
  describe('follow', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runFollow(makeClient(), ['follow', '--target', '2244994945'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --target', async () => {
      await expect(
        runFollow(makeClient(), ['follow', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('POSTs /users/{id}/following with {target_user_id} body', async () => {
      const fetchMock = mockFetch({ data: { following: true, pending_follow: false } });
      vi.stubGlobal('fetch', fetchMock);

      await runFollow(
        makeClient(),
        ['follow', '--user-id', '111', '--target', '2244994945'],
        CFG,
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/following');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ target_user_id: '2244994945' });
      const written = out.mock.calls.flat().join('');
      expect(written).toContain('pending_follow');
      expect(written).toMatch(/\n$/);
    });
  });

  // ─── unfollow ──────────────────────────────────────────────────────────────
  describe('unfollow', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runFollow(makeClient(), ['unfollow', '--target', '2244994945'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --target', async () => {
      await expect(
        runFollow(makeClient(), ['unfollow', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('DELETEs /users/{source}/following/{target}', async () => {
      const fetchMock = mockFetch({ data: { following: false } });
      vi.stubGlobal('fetch', fetchMock);

      await runFollow(
        makeClient(),
        ['unfollow', '--user-id', '111', '--target', '2244994945'],
        CFG,
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/following/2244994945');
      expect(init.method).toBe('DELETE');
      const written = out.mock.calls.flat().join('');
      expect(written).toContain('following');
    });
  });

  // ─── redaction ─────────────────────────────────────────────────────────────
  it('redacts the user token from stdout', async () => {
    // Secret embedded in the response data — must be redacted before printing.
    const fetchMock = mockFetch({
      data: { following: true, note: `leaked-${CFG.oauth2AccessToken}` },
    });
    vi.stubGlobal('fetch', fetchMock);

    await runFollow(
      makeClient(),
      ['follow', '--user-id', '111', '--target', '222'],
      CFG,
    );

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(CFG.oauth2AccessToken);
    expect(written).toContain('[REDACTED]');
  });
});
