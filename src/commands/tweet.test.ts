import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runTweet } from './tweet.js';
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

describe('runTweet dispatch', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError on an unknown sub-action', async () => {
    await expect(runTweet(makeClient(), ['frobnicate'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError on no sub-action', async () => {
    await expect(runTweet(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── get ────────────────────────────────────────────────────────────────────────

describe('runTweet get', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id/--ids', async () => {
    await expect(runTweet(makeClient(), ['get'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError when both --id and --ids are given', async () => {
    await expect(
      runTweet(makeClient(), ['get', '--id', '20', '--ids', '20,21'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('GETs /tweets/{id} for a single lookup', async () => {
    const fetchMock = mockFetch({ data: { id: '20', text: 'just setting up my twttr' } });
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['get', '--id', '20'], CFG);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tweets/20');
    expect(init.method).toBe('GET');
    expect(out.mock.calls.flat().join('')).toContain('twttr');
  });

  it('GETs /tweets?ids= for a batch lookup and maps field flags', async () => {
    const fetchMock = mockFetch({ data: [{ id: '20' }, { id: '21' }] });
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(
      makeClient(),
      ['get', '--ids', '20,21', '--tweet-fields', 'created_at', '--expansions', 'author_id'],
      CFG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    const decoded = decodeURIComponent(url);
    expect(url).toContain('/tweets?');
    expect(decoded).toContain('ids=20,21');
    expect(decoded).toContain('tweet.fields=created_at');
    expect(decoded).toContain('expansions=author_id');
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({ data: { id: '20', text: `leak ${SECRET}` } });
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['get', '--id', '20'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── create ───────────────────────────────────────────────────────────────────

describe('runTweet create', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError with no content (no text/media/poll/quote)', async () => {
    await expect(runTweet(makeClient(), ['create'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError when media/poll/quote are combined', async () => {
    await expect(
      runTweet(
        makeClient(),
        ['create', '--media-ids', '123', '--quote', '456'],
        CFG,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError when --poll-options is given without --poll-duration', async () => {
    await expect(
      runTweet(makeClient(), ['create', '--poll-options', 'a,b'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs /tweets with text', async () => {
    const fetchMock = mockFetch({ data: { id: '1445880548472328192', text: 'Hello!' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['create', '--text', 'Hello!'], CFG);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tweets');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['text']).toBe('Hello!');
  });

  it('maps --reply-to to reply.in_reply_to_tweet_id', async () => {
    const fetchMock = mockFetch({ data: { id: '2' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(
      makeClient(),
      ['create', '--text', 'a reply', '--reply-to', '1234567890'],
      CFG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['reply']).toEqual({ in_reply_to_tweet_id: '1234567890' });
  });

  it('maps --quote to quote_tweet_id', async () => {
    const fetchMock = mockFetch({ data: { id: '3' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['create', '--quote', '999'], CFG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['quote_tweet_id']).toBe('999');
  });

  it('maps --media-ids to media.media_ids[] (split + trimmed)', async () => {
    const fetchMock = mockFetch({ data: { id: '4' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(
      makeClient(),
      ['create', '--text', 'pic', '--media-ids', '111, 222'],
      CFG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['media']).toEqual({ media_ids: ['111', '222'] });
  });

  it('maps --poll-options + --poll-duration to poll object', async () => {
    const fetchMock = mockFetch({ data: { id: '5' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(
      makeClient(),
      ['create', '--text', 'vote', '--poll-options', 'Red,Blue,Green', '--poll-duration', '1440'],
      CFG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['poll']).toEqual({
      options: ['Red', 'Blue', 'Green'],
      duration_minutes: 1440,
    });
  });

  it('passes --reply-settings through', async () => {
    const fetchMock = mockFetch({ data: { id: '6' } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(
      makeClient(),
      ['create', '--text', 'x', '--reply-settings', 'mentionedUsers'],
      CFG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['reply_settings']).toBe('mentionedUsers');
  });

  it('redacts the credential from stdout', async () => {
    const fetchMock = mockFetch({ data: { id: '7', text: `leak ${SECRET}` } }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['create', '--text', 'hi'], CFG);

    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('runTweet delete', () => {
  let out: ReturnType<typeof spyStdout>;
  beforeEach(() => {
    out = spyStdout();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without an id', async () => {
    await expect(runTweet(makeClient(), ['delete'], CFG)).rejects.toThrow(UsageError);
  });

  it('DELETEs /tweets/{id} via --id', async () => {
    const fetchMock = mockFetch({ data: { deleted: true } });
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['delete', '--id', '20'], CFG);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tweets/20');
    expect(init.method).toBe('DELETE');
    expect(out.mock.calls.flat().join('')).toContain('deleted');
  });

  it('DELETEs /tweets/{id} via positional', async () => {
    const fetchMock = mockFetch({ data: { deleted: true } });
    vi.stubGlobal('fetch', fetchMock);

    await runTweet(makeClient(), ['delete', '20'], CFG);

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/tweets/20');
  });
});
