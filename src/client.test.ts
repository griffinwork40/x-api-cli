import { describe, it, expect, vi, afterEach } from 'vitest';
import { XClient } from './client.js';
import { XApiError } from './types.js';
import { RateLimitError } from './errors.js';
import type { XClientConfig, XEnvelope } from './types.js';

const BEARER = 'BEARERTOKEN_ABCD1234';

function bearerClient(overrides: Partial<XClientConfig> = {}): XClient {
  return new XClient({ bearerToken: BEARER, baseUrl: 'https://api.x.com/2', ...overrides });
}

function oauth1Client(): XClient {
  return new XClient({
    baseUrl: 'https://api.x.com/2',
    oauth1: {
      apiKey: 'CK_ABCD1234',
      apiSecret: 'CS_ABCD1234',
      accessToken: 'AT_ABCD1234',
      accessTokenSecret: 'ATS_ABCD1234',
    },
  });
}

function mockFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(body === null ? null : JSON.stringify(body), { status, headers }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── GET: URL + query ───────────────────────────────────────────────────────────

describe('XClient.get', () => {
  it('builds the correct URL with query params', async () => {
    const fetchMock = mockFetch({ data: { id: '20' } });
    vi.stubGlobal('fetch', fetchMock);

    await bearerClient().get('/tweets/20', { 'tweet.fields': 'created_at', ids: undefined });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.com/2/tweets/20?tweet.fields=created_at');
    expect(init.method).toBe('GET');
  });

  it('sends the Bearer Authorization header in bearer mode', async () => {
    const fetchMock = mockFetch({ data: {} });
    vi.stubGlobal('fetch', fetchMock);

    await bearerClient().get('/users/me');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${BEARER}`);
  });

  it('sends the same Bearer shape for an OAuth2 user token', async () => {
    const fetchMock = mockFetch({ data: {} });
    vi.stubGlobal('fetch', fetchMock);

    const client = new XClient({ oauth2AccessToken: 'OAUTH2_USER_TOKEN' });
    await client.get('/users/me');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer OAUTH2_USER_TOKEN');
  });
});

// ─── POST: JSON body + Content-Type ─────────────────────────────────────────────

describe('XClient.post', () => {
  it('sends a JSON body and Content-Type header', async () => {
    const fetchMock = mockFetch({ data: { id: '99' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await bearerClient().post('/tweets', { text: 'hello' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.com/2/tweets');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' });
  });
});

// ─── OAuth1 header ──────────────────────────────────────────────────────────────

describe('XClient OAuth1 signing', () => {
  it('emits an "OAuth ..." Authorization header containing oauth_signature=', async () => {
    const fetchMock = mockFetch({ data: {} });
    vi.stubGlobal('fetch', fetchMock);

    await oauth1Client().get('/users/me');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']?.startsWith('OAuth ')).toBe(true);
    expect(headers['Authorization']).toContain('oauth_signature=');
    expect(headers['Authorization']).toContain('oauth_consumer_key="CK_ABCD1234"');
  });

  it('does NOT set Bearer when in oauth1 mode', async () => {
    const fetchMock = mockFetch({ data: {} });
    vi.stubGlobal('fetch', fetchMock);

    await oauth1Client().post('/tweets', { text: 'hi' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']?.startsWith('OAuth ')).toBe(true);
    // JSON body still sent normally
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi' });
  });
});

// ─── Full envelope return (locked decision #2) ──────────────────────────────────

describe('XClient returns the full envelope', () => {
  it('returns { data, includes, meta } intact (NOT unwrapped data)', async () => {
    const envelope = {
      data: { id: '20', text: 't' },
      includes: { users: [{ id: '1' }] },
      meta: { result_count: 1 },
    };
    vi.stubGlobal('fetch', mockFetch(envelope));

    const result = await bearerClient().get<XEnvelope<unknown>>('/tweets/20');
    expect(result).toEqual(envelope);
    // proves it is NOT unwrapped to just data
    expect((result as XEnvelope<unknown>).data).toEqual({ id: '20', text: 't' });
    expect((result as XEnvelope<unknown>).includes).toEqual({ users: [{ id: '1' }] });
  });

  it('returns a partial-errors envelope (HTTP 200 with data AND errors) intact', async () => {
    const envelope = {
      data: [{ id: '123', text: '...' }],
      errors: [
        {
          value: '456',
          detail: 'Could not find tweet with ids: [456].',
          title: 'Not Found Error',
          type: 'https://api.twitter.com/2/problems/resource-not-found',
        },
      ],
    };
    vi.stubGlobal('fetch', mockFetch(envelope, 200));

    const result = await bearerClient().get<XEnvelope<unknown>>('/tweets', { ids: '123,456' });
    // errors[] must NOT be dropped
    expect((result as XEnvelope<unknown>).errors).toHaveLength(1);
    expect((result as XEnvelope<unknown>).errors?.[0]?.value).toBe('456');
    expect((result as XEnvelope<unknown>).data).toHaveLength(1);
  });

  it('populates lastMeta on a 2xx response', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [], meta: { next_token: 'abc', result_count: 0 } }));
    const client = bearerClient();
    await client.get('/tweets/search/recent', { query: 'x' });
    expect(client.lastMeta).toEqual({ next_token: 'abc', result_count: 0 });
  });

  it('returns null on 204 No Content', async () => {
    vi.stubGlobal('fetch', mockFetch(null, 204, {}));
    const result = await bearerClient().delete('/tweets/20');
    expect(result).toBeNull();
  });
});

// ─── Rate-limit capture ─────────────────────────────────────────────────────────

describe('XClient rate-limit capture', () => {
  it('captures x-rate-limit-* headers into lastRateLimit', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ data: {} }, 200, {
        'Content-Type': 'application/json',
        'x-rate-limit-limit': '900',
        'x-rate-limit-remaining': '899',
        'x-rate-limit-reset': '1700000000',
      }),
    );
    const client = bearerClient();
    await client.get('/users/me');
    expect(client.lastRateLimit).toEqual({
      limit: 900,
      remaining: 899,
      reset: 1700000000,
      retryAfter: undefined,
    });
  });

  it('tolerates missing rate-limit headers (all undefined)', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: {} }));
    const client = bearerClient();
    await client.get('/users/me');
    expect(client.lastRateLimit).toEqual({
      limit: undefined,
      remaining: undefined,
      reset: undefined,
      retryAfter: undefined,
    });
  });
});

// ─── 429 → RateLimitError ────────────────────────────────────────────────────────

describe('XClient 429 handling', () => {
  it('throws RateLimitError with resetInSeconds computed from x-rate-limit-reset', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const resetAt = nowSec + 42;
    vi.stubGlobal(
      'fetch',
      mockFetch({ title: 'Too Many Requests' }, 429, {
        'Content-Type': 'application/json',
        'x-rate-limit-reset': String(resetAt),
      }),
    );

    const client = bearerClient();
    const err = await client.get('/users/me').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    // allow ±1s clock slack
    expect((err as RateLimitError).resetInSeconds).toBeGreaterThanOrEqual(41);
    expect((err as RateLimitError).resetInSeconds).toBeLessThanOrEqual(42);
  });

  it('falls back to Retry-After when x-rate-limit-reset is absent', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ title: 'Too Many Requests' }, 429, {
        'Content-Type': 'application/json',
        'Retry-After': '15',
      }),
    );
    const err = await bearerClient().get('/users/me').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).resetInSeconds).toBe(15);
  });

  it('never returns a negative resetInSeconds (past reset → 0)', async () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    vi.stubGlobal(
      'fetch',
      mockFetch({ title: 'Too Many Requests' }, 429, {
        'Content-Type': 'application/json',
        'x-rate-limit-reset': String(past),
      }),
    );
    const err = await bearerClient().get('/users/me').catch((e) => e);
    expect((err as RateLimitError).resetInSeconds).toBe(0);
  });
});

// ─── Error parsing: RFC 7807 + legacy ────────────────────────────────────────────

describe('XClient error parsing', () => {
  it('parses an RFC 7807 Problem into XApiError with .type and .status', async () => {
    const problem = {
      title: 'Unsupported Authentication',
      detail:
        'Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint.',
      type: 'https://api.twitter.com/2/problems/unsupported-authentication',
      status: 403,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch(problem, 403, { 'Content-Type': 'application/problem+json' }),
    );

    const err = (await bearerClient().get('/users/me').catch((e) => e)) as XApiError;
    expect(err).toBeInstanceOf(XApiError);
    expect(err.status).toBe(403);
    expect(err.type).toBe('https://api.twitter.com/2/problems/unsupported-authentication');
    expect(err.title).toBe('Unsupported Authentication');
    expect(err.problemTypeSuffix()).toBe('unsupported-authentication');
    expect(err.message).toContain('Unsupported Authentication');
  });

  it('parses a legacy {errors:[{code,message}]} into XApiError with .code', async () => {
    const legacy = { errors: [{ code: 32, message: 'Could not authenticate you.' }] };
    vi.stubGlobal('fetch', mockFetch(legacy, 401));

    const err = (await bearerClient().get('/users/me').catch((e) => e)) as XApiError;
    expect(err).toBeInstanceOf(XApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe(32);
    expect(err.message).toContain('Could not authenticate you.');
  });

  it('attaches partial errors to a thrown XApiError when the error body carries errors[]', async () => {
    const body = {
      errors: [
        {
          title: 'Not Found Error',
          detail: 'Could not find tweet with id: [1].',
          type: 'https://api.twitter.com/2/problems/resource-not-found',
        },
      ],
    };
    vi.stubGlobal('fetch', mockFetch(body, 404));
    const err = (await bearerClient().get('/tweets/1').catch((e) => e)) as XApiError;
    expect(err).toBeInstanceOf(XApiError);
    expect(err.status).toBe(404);
    // legacy-style: no numeric code, but the message comes from the item and type is captured
    expect(err.message).toContain('Not Found Error');
  });

  it('falls back to HTTP <status> <statusText> when the body is unparseable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json', { status: 500, statusText: 'Server Error' })),
    );
    const err = (await bearerClient().get('/users/me').catch((e) => e)) as XApiError;
    expect(err).toBeInstanceOf(XApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('HTTP 500');
  });
});

// ─── Secret redaction in thrown errors ───────────────────────────────────────────

describe('XClient secret redaction', () => {
  it('redacts the bearer token if it leaks into an error detail', async () => {
    const problem = {
      title: 'Invalid Request',
      detail: `Bad token ${BEARER} supplied`,
      type: 'https://api.twitter.com/2/problems/invalid-request',
      status: 400,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch(problem, 400, { 'Content-Type': 'application/problem+json' }),
    );

    const err = (await bearerClient().get('/users/me').catch((e) => e)) as XApiError;
    expect(err.message).not.toContain(BEARER);
    expect(err.message).toContain('[REDACTED]');
  });

  it('redacts oauth1 secrets from a thrown error', async () => {
    const problem = {
      title: 'Boom',
      detail: `secret leak CS_ABCD1234 here`,
      type: 'https://api.twitter.com/2/problems/invalid-request',
      status: 400,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch(problem, 400, { 'Content-Type': 'application/problem+json' }),
    );
    const err = (await oauth1Client().get('/users/me').catch((e) => e)) as XApiError;
    expect(err.message).not.toContain('CS_ABCD1234');
    expect(err.message).toContain('[REDACTED]');
  });
});
