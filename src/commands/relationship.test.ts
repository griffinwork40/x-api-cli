import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import type { XClientConfig } from '../types.js';
import { runRelationship, RELATIONSHIP_HELP } from './relationship.js';

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

describe('runRelationship', () => {
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
    await expect(runRelationship(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError with no sub-action', async () => {
    await expect(runRelationship(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });

  // ─── mute ──────────────────────────────────────────────────────────────────
  describe('mute', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runRelationship(makeClient(), ['mute', '--target', '222'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --target', async () => {
      await expect(
        runRelationship(makeClient(), ['mute', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('POSTs /users/{id}/muting with {target_user_id} body', async () => {
      const fetchMock = mockFetch({ data: { muting: true } });
      vi.stubGlobal('fetch', fetchMock);

      await runRelationship(
        makeClient(),
        ['mute', '--user-id', '111', '--target', '2244994945'],
        CFG,
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/muting');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ target_user_id: '2244994945' });
      const written = out.mock.calls.flat().join('');
      expect(written).toContain('muting');
      expect(written).toMatch(/\n$/);
    });
  });

  // ─── unmute ──────────────────────────────────────────────────────────────
  describe('unmute', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runRelationship(makeClient(), ['unmute', '--target', '222'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --target', async () => {
      await expect(
        runRelationship(makeClient(), ['unmute', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('DELETEs /users/{source}/muting/{target}', async () => {
      const fetchMock = mockFetch({ data: { muting: false } });
      vi.stubGlobal('fetch', fetchMock);

      await runRelationship(
        makeClient(),
        ['unmute', '--user-id', '111', '--target', '2244994945'],
        CFG,
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/muting/2244994945');
      expect(init.method).toBe('DELETE');
      expect(out.mock.calls.flat().join('')).toContain('muting');
    });
  });

  // ─── block ──────────────────────────────────────────────────────────────
  describe('block', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runRelationship(makeClient(), ['block', '--target', '222'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --target', async () => {
      await expect(
        runRelationship(makeClient(), ['block', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('POSTs /users/{id}/blocking with {target_user_id} body', async () => {
      const fetchMock = mockFetch({ data: { blocking: true } });
      vi.stubGlobal('fetch', fetchMock);

      await runRelationship(
        makeClient(),
        ['block', '--user-id', '111', '--target', '2244994945'],
        CFG,
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/blocking');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ target_user_id: '2244994945' });
      expect(out.mock.calls.flat().join('')).toContain('blocking');
    });
  });

  // ─── unblock ──────────────────────────────────────────────────────────────
  describe('unblock', () => {
    it('throws UsageError without --user-id', async () => {
      await expect(
        runRelationship(makeClient(), ['unblock', '--target', '222'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError without --target', async () => {
      await expect(
        runRelationship(makeClient(), ['unblock', '--user-id', '111'], CFG),
      ).rejects.toThrow(UsageError);
    });

    it('DELETEs /users/{source}/blocking/{target}', async () => {
      const fetchMock = mockFetch({ data: { blocking: false } });
      vi.stubGlobal('fetch', fetchMock);

      await runRelationship(
        makeClient(),
        ['unblock', '--user-id', '111', '--target', '2244994945'],
        CFG,
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/users/111/blocking/2244994945');
      expect(init.method).toBe('DELETE');
      expect(out.mock.calls.flat().join('')).toContain('blocking');
    });
  });

  // ─── HELP notes the block Enterprise-gating caveat ─────────────────────────
  it('HELP text notes block may be Enterprise-gated', () => {
    expect(RELATIONSHIP_HELP.toLowerCase()).toContain('enterprise');
  });

  // ─── redaction ─────────────────────────────────────────────────────────────
  it('redacts the user token from stdout', async () => {
    const fetchMock = mockFetch({
      data: { muting: true, note: `leaked-${CFG.oauth2AccessToken}` },
    });
    vi.stubGlobal('fetch', fetchMock);

    await runRelationship(
      makeClient(),
      ['mute', '--user-id', '111', '--target', '222'],
      CFG,
    );

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(CFG.oauth2AccessToken);
    expect(written).toContain('[REDACTED]');
  });
});
