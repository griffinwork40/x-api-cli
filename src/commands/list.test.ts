import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runList } from './list.js';
import type { XClientConfig } from '../types.js';

const CFG: XClientConfig = { bearerToken: 'TESTBEARER_ABCD1234', baseUrl: 'https://api.x.com/2' };
const makeClient = (): XClient => new XClient(CFG);

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function firstCall(m: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return m.mock.calls[0] as [string, RequestInit];
}

describe('runList dispatch', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError on unknown subcommand', async () => {
    await expect(runList(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError on missing subcommand', async () => {
    await expect(runList(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── get ────────────────────────────────────────────────────────────────────────

describe('runList get', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runList(makeClient(), ['get'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /lists/{id} with field flags', async () => {
    const fetchMock = mockFetch({ data: { id: '84839422', name: 'Official Accounts' } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(
      makeClient(),
      ['get', '--id', '84839422', '--list-fields', 'member_count', '--expansions', 'owner_id'],
      CFG,
    );
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/lists/84839422');
    expect(url).toContain('list.fields=member_count');
    expect(url).toContain('expansions=owner_id');
    expect(init.method).toBe('GET');
    expect(out.mock.calls.flat().join('')).toContain('Official Accounts');
  });

  it('redacts a secret leaked in response data', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: { id: '1', name: CFG.bearerToken } }));
    await runList(makeClient(), ['get', '--id', '1'], CFG);
    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(CFG.bearerToken as string);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── create ───────────────────────────────────────────────────────────────────

describe('runList create', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --name', async () => {
    await expect(runList(makeClient(), ['create'], CFG)).rejects.toThrow(UsageError);
  });

  it('POSTs /lists with {name, description, private}', async () => {
    const fetchMock = mockFetch({ data: { id: '1441162269824405510', name: 'Tech News' } }, 201);
    vi.stubGlobal('fetch', fetchMock);
    await runList(
      makeClient(),
      ['create', '--name', 'Tech News', '--description', 'journalists', '--private'],
      CFG,
    );
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/lists');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ name: 'Tech News', description: 'journalists', private: true });
  });

  it('POSTs /lists with only --name (no optional fields)', async () => {
    const fetchMock = mockFetch({ data: { id: '2', name: 'Solo' } }, 201);
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['create', '--name', 'Solo'], CFG);
    const [, init] = firstCall(fetchMock);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ name: 'Solo' });
    expect(body).not.toHaveProperty('private');
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe('runList update', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runList(makeClient(), ['update', '--name', 'X'], CFG)).rejects.toThrow(UsageError);
  });

  it('PUTs /lists/{id} with partial body', async () => {
    const fetchMock = mockFetch({ data: { updated: true } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['update', '--id', '99', '--description', 'new desc'], CFG);
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/lists/99');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ description: 'new desc' });
  });

  it('PUTs an empty body when no optional fields supplied', async () => {
    const fetchMock = mockFetch({ data: { updated: true } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['update', '--id', '99'], CFG);
    const [, init] = firstCall(fetchMock);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({});
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('runList delete', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runList(makeClient(), ['delete'], CFG)).rejects.toThrow(UsageError);
  });

  it('DELETEs /lists/{id}', async () => {
    const fetchMock = mockFetch({ data: { deleted: true } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['delete', '--id', '42'], CFG);
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/lists/42');
    expect(init.method).toBe('DELETE');
    expect(out.mock.calls.flat().join('')).toContain('deleted');
  });
});

// ─── members-add / members-remove ───────────────────────────────────────────────

describe('runList members-add', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(
      runList(makeClient(), ['members-add', '--user-id', '5'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError without --user-id', async () => {
    await expect(
      runList(makeClient(), ['members-add', '--id', '1'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs /lists/{id}/members with {user_id}', async () => {
    const fetchMock = mockFetch({ data: { is_member: true } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['members-add', '--id', '84839422', '--user-id', '2244994945'], CFG);
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/lists/84839422/members');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ user_id: '2244994945' });
  });
});

describe('runList members-remove', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('DELETEs /lists/{id}/members/{user_id}', async () => {
    const fetchMock = mockFetch({ data: { is_member: false } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['members-remove', '--id', '84839422', '--user-id', '2244994945'], CFG);
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/lists/84839422/members/2244994945');
    expect(init.method).toBe('DELETE');
  });
});

// ─── members-list / tweets / owned (read + pagination) ──────────────────────────

describe('runList members-list', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runList(makeClient(), ['members-list'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /lists/{id}/members (single page by default)', async () => {
    const fetchMock = mockFetch({
      data: [{ id: '1' }, { id: '2' }],
      meta: { result_count: 2, next_token: 'PAGE2' },
    });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['members-list', '--id', '84839422'], CFG);
    expect(fetchMock).toHaveBeenCalledOnce(); // no --all → do not follow next_token
    const [url] = firstCall(fetchMock);
    expect(url).toContain('/lists/84839422/members');
    const written = out.mock.calls.flat().join('');
    expect(written).toContain('"result_count": 2');
  });

  it('follows next_token across pages with --all', async () => {
    const page1 = new Response(
      JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'T2' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const page2 = new Response(
      JSON.stringify({ data: [{ id: '2' }], meta: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    vi.stubGlobal('fetch', fetchMock);

    await runList(makeClient(), ['members-list', '--id', '1', '--all'], CFG);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toContain('pagination_token=T2');
    const written = out.mock.calls.flat().join('');
    expect(written).toContain('"result_count": 2');
  });
});

describe('runList tweets', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('GETs /lists/{id}/tweets', async () => {
    const fetchMock = mockFetch({ data: [{ id: '20', text: 'hi' }], meta: { result_count: 1 } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['tweets', '--id', '84839422'], CFG);
    const [url] = firstCall(fetchMock);
    expect(url).toContain('/lists/84839422/tweets');
  });
});

describe('runList owned', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --id', async () => {
    await expect(runList(makeClient(), ['owned'], CFG)).rejects.toThrow(UsageError);
  });

  it('GETs /users/{id}/owned_lists', async () => {
    const fetchMock = mockFetch({ data: [{ id: '5', name: 'Mine' }], meta: { result_count: 1 } });
    vi.stubGlobal('fetch', fetchMock);
    await runList(makeClient(), ['owned', '--id', '2244994945'], CFG);
    const [url] = firstCall(fetchMock);
    expect(url).toContain('/users/2244994945/owned_lists');
  });

  it('caps pages with --max-pages even when --all is set', async () => {
    const mkPage = (id: string, next?: string) =>
      new Response(JSON.stringify({ data: [{ id }], meta: next ? { next_token: next } : {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkPage('1', 'T2'))
      .mockResolvedValueOnce(mkPage('2', 'T3'))
      .mockResolvedValueOnce(mkPage('3', 'T4'));
    vi.stubGlobal('fetch', fetchMock);

    await runList(makeClient(), ['owned', '--id', '1', '--all', '--max-pages', '2'], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2); // capped at 2 pages
  });

  it('throws UsageError for invalid --max-pages', async () => {
    await expect(
      runList(makeClient(), ['owned', '--id', '1', '--max-pages', '0'], CFG),
    ).rejects.toThrow(UsageError);
  });
});
