import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runAccount } from './account.js';
import type { XClientConfig } from '../types.js';

// A user-context config (oauth2 token) — whoami requires user context.
const SECRET = 'OAUTH2USERTOKEN_ABCD1234';
const CFG: XClientConfig = {
  oauth2AccessToken: SECRET,
  baseUrl: 'https://api.x.com/2',
  authMode: 'oauth2',
};
const makeClient = (): XClient => new XClient(CFG);

function mockFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
}

// Precise-typed stdout spy (a factory so `ReturnType<typeof spyStdout>` infers the
// exact MockInstance, avoiding the process.stdout.write-overload vs. vi.spyOn
// generic-default mismatch that a bare `ReturnType<typeof vi.spyOn>` annotation hits).
const spyStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('runAccount dispatch', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError on an unknown sub-action', async () => {
    await expect(runAccount(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('defaults to whoami when no sub-action is given', async () => {
    const fetchMock = mockFetch({ data: { id: '123', username: 'me' } });
    vi.stubGlobal('fetch', fetchMock);
    await runAccount(makeClient(), [], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/users/me');
  });
});

describe('runAccount whoami', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('GETs /users/me and prints the data', async () => {
    const fetchMock = mockFetch({ data: { id: '2244994945', username: 'XDevelopers' } });
    vi.stubGlobal('fetch', fetchMock);

    await runAccount(makeClient(), ['whoami'], CFG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/users/me');

    const written = out.mock.calls.flat().join('');
    expect(written).toContain('XDevelopers');
    expect(written).toMatch(/\n$/);
  });

  it('passes --user-fields as user.fields query param', async () => {
    const fetchMock = mockFetch({ data: { id: '1' } });
    vi.stubGlobal('fetch', fetchMock);

    await runAccount(makeClient(), ['whoami', '--user-fields', 'username,public_metrics'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(decodeURIComponent(url)).toContain('user.fields=username,public_metrics');
  });

  it('throws UsageError on an unknown flag (strict parseArgs)', async () => {
    // No network — parseArgs rejects the unknown flag before any fetch.
    await expect(runAccount(makeClient(), ['whoami', '--nope', 'x'], CFG)).rejects.toThrow();
  });

  it('redacts the credential from stdout', async () => {
    // Embed the secret in the response data → must never reach stdout.
    const fetchMock = mockFetch({ data: { id: '1', note: `tok=${SECRET}` } });
    vi.stubGlobal('fetch', fetchMock);

    await runAccount(makeClient(), ['whoami'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});

describe('runAccount rate-limit', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('does a cheap /users/me read and prints the captured rate-limit headers', async () => {
    const fetchMock = mockFetch(
      { data: { id: '1' } },
      200,
      {
        'Content-Type': 'application/json',
        'x-rate-limit-limit': '75',
        'x-rate-limit-remaining': '74',
        'x-rate-limit-reset': '1750000000',
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await runAccount(makeClient(), ['rate-limit'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/users/me');

    const written = out.mock.calls.flat().join('');
    // Prints lastRateLimit, not the body.
    expect(written).toContain('"limit": 75');
    expect(written).toContain('"remaining": 74');
    expect(written).toContain('"reset": 1750000000');
  });

  it('probes /users/by/username/{handle} when --username is given', async () => {
    const fetchMock = mockFetch(
      { data: { id: '1', username: 'jack' } },
      200,
      { 'Content-Type': 'application/json', 'x-rate-limit-remaining': '10' },
    );
    vi.stubGlobal('fetch', fetchMock);

    await runAccount(makeClient(), ['rate-limit', '--username', 'jack'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/users/by/username/jack');
  });
});
