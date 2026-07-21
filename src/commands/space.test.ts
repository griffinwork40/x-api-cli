import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runSpace } from './space.js';
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

describe('runSpace dispatch', () => {
  it('throws UsageError on unknown subcommand', async () => {
    await expect(runSpace(makeClient(), ['blah'], CFG)).rejects.toThrow(UsageError);
  });
  it('throws UsageError with no subcommand', async () => {
    await expect(runSpace(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('runSpace get', () => {
  it('throws UsageError when neither --id nor --ids given', async () => {
    await expect(runSpace(makeClient(), ['get'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError when both --id and --ids given', async () => {
    await expect(
      runSpace(makeClient(), ['get', '--id', '1DXxyRYNejbKM', '--ids', 'a,b'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('GETs /spaces/{id} for --id', async () => {
    const fetchMock = mockFetch({ data: { id: '1DXxyRYNejbKM', state: 'live' } });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(makeClient(), ['get', '--id', '1DXxyRYNejbKM'], CFG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/spaces/1DXxyRYNejbKM');
    expect(init.method).toBe('GET');
    expect(written()).toContain('live');
  });

  it('GETs /spaces?ids= for --ids', async () => {
    const fetchMock = mockFetch({ data: [{ id: 'a' }, { id: 'b' }] });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(makeClient(), ['get', '--ids', 'a,b'], CFG);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/spaces?');
    expect(decodeURIComponent(url)).toContain('ids=a,b');
  });

  it('passes --space-fields, --topic-fields, --user-fields, --expansions', async () => {
    const fetchMock = mockFetch({ data: { id: '1DXxyRYNejbKM' } });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(
      makeClient(),
      [
        'get',
        '--id',
        '1DXxyRYNejbKM',
        '--space-fields',
        'title,state,host_ids',
        '--topic-fields',
        'name',
        '--user-fields',
        'username',
        '--expansions',
        'host_ids',
      ],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('space.fields=title,state,host_ids');
    expect(decoded).toContain('topic.fields=name');
    expect(decoded).toContain('user.fields=username');
    expect(decoded).toContain('expansions=host_ids');
  });

  it('redacts secrets in get output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: { id: '1DXxyRYNejbKM', note: BEARER } }));
    await runSpace(makeClient(), ['get', '--id', '1DXxyRYNejbKM'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});

// ─── search ─────────────────────────────────────────────────────────────────────

describe('runSpace search', () => {
  it('throws UsageError without --query', async () => {
    await expect(runSpace(makeClient(), ['search'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError for invalid --state', async () => {
    await expect(
      runSpace(makeClient(), ['search', '--query', 'crypto', '--state', 'ended'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('GETs /spaces/search with query', async () => {
    const fetchMock = mockFetch({
      data: [{ id: '1DXxyRYNejbKM', state: 'live' }],
      meta: { result_count: 1 },
    });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(makeClient(), ['search', '--query', 'crypto'], CFG);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/spaces/search');
    expect(url).toContain('query=crypto');
    expect(init.method).toBe('GET');
    // envelope printed (carries meta.result_count for a non-paginated search)
    expect(written()).toContain('result_count');
  });

  it('passes --state and --max-results', async () => {
    const fetchMock = mockFetch({ data: [], meta: { result_count: 0 } });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(
      makeClient(),
      ['search', '--query', 'crypto', '--state', 'live', '--max-results', '50'],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('state=live');
    expect(url).toContain('max_results=50');
  });

  it('throws UsageError for invalid --max-results', async () => {
    await expect(
      runSpace(makeClient(), ['search', '--query', 'crypto', '--max-results', '0'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('does NOT paginate even when meta.next_token would be present', async () => {
    // search is not cursor-paginated; even a spurious next_token must not trigger a 2nd call
    const fetchMock = mockFetch({
      data: [{ id: 'a' }],
      meta: { result_count: 1, next_token: 'SHOULD_BE_IGNORED' },
    });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(makeClient(), ['search', '--query', 'crypto'], CFG);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('passes --space-fields', async () => {
    const fetchMock = mockFetch({ data: [], meta: {} });
    vi.stubGlobal('fetch', fetchMock);
    await runSpace(
      makeClient(),
      ['search', '--query', 'crypto', '--space-fields', 'title,state'],
      CFG,
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('space.fields=title,state');
  });

  it('redacts secrets in search output', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: 'a', note: BEARER }], meta: {} }));
    await runSpace(makeClient(), ['search', '--query', 'crypto'], CFG);
    expect(written()).not.toContain(BEARER);
    expect(written()).toContain('[REDACTED]');
  });
});
