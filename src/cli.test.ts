import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { XClient } from './client.js';
import { UsageError, MissingCredentialsError } from './errors.js';
import type { XClientConfig } from './types.js';

type RunFn = (client: XClient, args: string[], cfg: XClientConfig) => Promise<void>;

// Mock a couple of command modules so we can assert dispatch + the resolved cfg/args
// WITHOUT any real network call. `vi.hoisted` defines the spies so the (hoisted) vi.mock
// factories can reference them without a TDZ error.
const { tweetRun, accountRun } = vi.hoisted(() => ({
  tweetRun: vi.fn<RunFn>(async () => {}),
  accountRun: vi.fn<RunFn>(async () => {}),
}));
vi.mock('./commands/tweet.js', () => ({ runTweet: tweetRun, TWEET_HELP: 'TWEET_HELP_TEXT' }));
vi.mock('./commands/account.js', () => ({ runAccount: accountRun, ACCOUNT_HELP: 'ACCOUNT_HELP_TEXT' }));

import { runCli } from './cli.js';

const argv = (...args: string[]): string[] => ['node', '/abs/dist/cli.js', ...args];
const sink = () => ({ secrets: [] as string[] });

let outSpy: MockInstance;

beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  tweetRun.mockClear();
  accountRun.mockClear();
});
afterEach(() => {
  outSpy.mockRestore();
  vi.unstubAllGlobals();
});

const stdout = (): string => outSpy.mock.calls.flat().join('');

// ─── top-level help / no command ────────────────────────────────────────────────

describe('runCli — usage', () => {
  it('prints top-level usage and returns 0 for --help', async () => {
    const code = await runCli(argv('--help'), sink());
    expect(code).toBe(0);
    const written = stdout();
    expect(written).toContain('Usage: x <command>');
    // lists every command
    for (const cmd of ['tweet', 'search', 'timeline', 'user', 'like', 'retweet', 'follow',
      'relationship', 'bookmark', 'list', 'dm', 'media', 'space', 'account']) {
      expect(written).toContain(cmd);
    }
    expect(written).toContain('--help');
  });

  it('prints top-level usage and returns 0 when no command is given', async () => {
    const code = await runCli(argv(), sink());
    expect(code).toBe(0);
    expect(stdout()).toContain('Usage: x <command>');
  });

  it('prints a command\'s help for `x <command> --help` (exit 0, no run)', async () => {
    const code = await runCli(argv('tweet', '--help'), sink());
    expect(code).toBe(0);
    expect(stdout()).toContain('TWEET_HELP_TEXT');
    expect(tweetRun).not.toHaveBeenCalled();
  });
});

// ─── unknown command → UsageError ─────────────────────────────────────────────────

describe('runCli — unknown command', () => {
  it('throws UsageError for a bogus command', async () => {
    await expect(runCli(argv('boguscmd'), sink())).rejects.toThrow(UsageError);
  });
});

// ─── auth-needs resolution + dispatch ─────────────────────────────────────────────
// runCli reads process.env internally; swap it in/out around each call.

describe('runCli — dispatch with injected env', () => {
  const withEnv = async (env: Record<string, string>, args: string[]): Promise<number> => {
    const saved = { ...process.env };
    // Replace env for the duration of the call.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return await runCli(argv(...args), sink());
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  it('read command (tweet get) resolves Bearer and dispatches with (client, rest, cfg)', async () => {
    const code = await withEnv({ X_BEARER_TOKEN: 'BEARER_TESTTOKEN_1234' }, ['tweet', 'get', '--id', '20']);
    expect(code).toBe(0);
    expect(tweetRun).toHaveBeenCalledOnce();
    const [client, rest, cfg] = tweetRun.mock.calls[0]!;
    expect(client).toBeInstanceOf(XClient);
    expect(rest).toEqual(['get', '--id', '20']); // --auth stripped; sub-action + flags intact
    expect(cfg.authMode).toBe('bearer');
    expect(cfg.bearerToken).toBe('BEARER_TESTTOKEN_1234');
  });

  it('strips a global --auth flag before dispatching to the command', async () => {
    const code = await withEnv(
      { X_OAUTH2_ACCESS_TOKEN: 'OAUTH2_TESTTOKEN_1234' },
      ['tweet', 'create', '--text', 'hi', '--auth', 'oauth2'],
    );
    expect(code).toBe(0);
    const [, rest, cfg] = tweetRun.mock.calls[0]!;
    expect(rest).toEqual(['create', '--text', 'hi']); // no --auth in the command's args
    expect(cfg.authMode).toBe('oauth2');
  });

  it('account whoami (needsUser) with NO creds throws MissingCredentialsError (before any run)', async () => {
    await expect(
      withEnv({}, ['account', 'whoami']),
    ).rejects.toThrow(MissingCredentialsError);
    expect(accountRun).not.toHaveBeenCalled();
  });

  it('account whoami (needsUser) rejects app-only Bearer', async () => {
    await expect(
      withEnv({ X_BEARER_TOKEN: 'BEARER_TESTTOKEN_1234' }, ['account', 'whoami']),
    ).rejects.toThrow(MissingCredentialsError);
  });

  it('account default sub-action (no sub) resolves needsUser (whoami default)', async () => {
    // No creds → the needsUser requirement must fire even without an explicit "whoami".
    await expect(withEnv({}, ['account'])).rejects.toThrow(MissingCredentialsError);
  });

  it('invalid --auth value throws UsageError', async () => {
    await expect(
      withEnv({ X_BEARER_TOKEN: 'BEARER_TESTTOKEN_1234' }, ['tweet', 'get', '--id', '1', '--auth', 'nope']),
    ).rejects.toThrow(UsageError);
  });
});
