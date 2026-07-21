import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { runDm } from './dm.js';
import type { XClientConfig } from '../types.js';

// DMs are user-context writes; use an oauth2 token config so redaction covers that secret.
const CFG: XClientConfig = {
  oauth2AccessToken: 'TESTOAUTH2_TOKEN_WXYZ9876',
  baseUrl: 'https://api.x.com/2',
};
const makeClient = (): XClient => new XClient(CFG);

function mockFetch(body: unknown, status = 201): ReturnType<typeof vi.fn> {
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

describe('runDm dispatch', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError on unknown subcommand', async () => {
    await expect(runDm(makeClient(), ['bogus'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError on missing subcommand', async () => {
    await expect(runDm(makeClient(), [], CFG)).rejects.toThrow(UsageError);
  });
});

// ─── send ─────────────────────────────────────────────────────────────────────

describe('runDm send', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError when neither --participant nor --conversation given', async () => {
    await expect(runDm(makeClient(), ['send', '--text', 'hi'], CFG)).rejects.toThrow(UsageError);
  });

  it('throws UsageError when BOTH --participant and --conversation given', async () => {
    await expect(
      runDm(makeClient(), ['send', '--participant', '5', '--conversation', '9', '--text', 'hi'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError when no --text and no --media-id', async () => {
    await expect(
      runDm(makeClient(), ['send', '--participant', '944480690'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs to /dm_conversations/with/{participant_id}/messages with {text}', async () => {
    const fetchMock = mockFetch({
      data: { dm_conversation_id: '123-456', dm_event_id: '1146654567674912769' },
    });
    vi.stubGlobal('fetch', fetchMock);
    await runDm(makeClient(), ['send', '--participant', '944480690', '--text', 'Hello!'], CFG);
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/dm_conversations/with/944480690/messages');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ text: 'Hello!' });
    expect(out.mock.calls.flat().join('')).toContain('dm_event_id');
  });

  it('POSTs to /dm_conversations/{id}/messages with --conversation', async () => {
    const fetchMock = mockFetch({ data: { dm_conversation_id: '1582103724607971328' } });
    vi.stubGlobal('fetch', fetchMock);
    await runDm(
      makeClient(),
      ['send', '--conversation', '1582103724607971328', '--text', 'Another msg'],
      CFG,
    );
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/dm_conversations/1582103724607971328/messages');
    expect(url).not.toContain('/with/');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ text: 'Another msg' });
  });

  it('maps --media-id to attachments:[{media_id}]', async () => {
    const fetchMock = mockFetch({ data: { dm_conversation_id: '1', dm_event_id: '2' } });
    vi.stubGlobal('fetch', fetchMock);
    await runDm(
      makeClient(),
      ['send', '--participant', '5', '--text', 'pic', '--media-id', '1146654567674912769'],
      CFG,
    );
    const [, init] = firstCall(fetchMock);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      text: 'pic',
      attachments: [{ media_id: '1146654567674912769' }],
    });
  });

  it('allows --media-id with no --text (attachment-only message)', async () => {
    const fetchMock = mockFetch({ data: { dm_conversation_id: '1', dm_event_id: '2' } });
    vi.stubGlobal('fetch', fetchMock);
    await runDm(makeClient(), ['send', '--participant', '5', '--media-id', '77'], CFG);
    const [, init] = firstCall(fetchMock);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ attachments: [{ media_id: '77' }] });
  });

  it('redacts a secret leaked in response data', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ data: { dm_conversation_id: CFG.oauth2AccessToken, dm_event_id: '2' } }),
    );
    await runDm(makeClient(), ['send', '--participant', '5', '--text', 'hi'], CFG);
    const written = out.mock.calls.flat().join('');
    expect(written).not.toContain(CFG.oauth2AccessToken as string);
    expect(written).toContain('[REDACTED]');
  });
});

// ─── create-conversation ────────────────────────────────────────────────────────

describe('runDm create-conversation', () => {
  let out: MockInstance;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    out.mockRestore();
  });

  it('throws UsageError without --participants', async () => {
    await expect(
      runDm(makeClient(), ['create-conversation', '--text', 'hi'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('throws UsageError without --text', async () => {
    await expect(
      runDm(makeClient(), ['create-conversation', '--participants', '1,2'], CFG),
    ).rejects.toThrow(UsageError);
  });

  it('POSTs /dm_conversations with Group + participant_ids[] + message', async () => {
    const fetchMock = mockFetch({
      data: { dm_conversation_id: '1346889436626259968', dm_event_id: '128341038123' },
    });
    vi.stubGlobal('fetch', fetchMock);
    await runDm(
      makeClient(),
      ['create-conversation', '--participants', '944480690, 906948460078698496', '--text', 'Welcome!'],
      CFG,
    );
    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('/dm_conversations');
    expect(url).not.toContain('/messages');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      conversation_type: 'Group',
      participant_ids: ['944480690', '906948460078698496'], // trimmed CSV
      message: { text: 'Welcome!' },
    });
  });
});
