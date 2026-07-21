import { describe, it, expect } from 'vitest';
import { resolveConfig, makeClient } from './auth.js';
import { MissingCredentialsError, UsageError } from './errors.js';
import { XClient } from './client.js';
import type { AuthMode } from './types.js';

// ─── Env fixtures ────────────────────────────────────────────────────────────────

const BEARER = { X_BEARER_TOKEN: 'bearer-tok' };
const OAUTH1 = {
  X_API_KEY: 'ck',
  X_API_SECRET: 'cs',
  X_ACCESS_TOKEN: 'at',
  X_ACCESS_TOKEN_SECRET: 'ats',
};
const OAUTH2 = { X_OAUTH2_ACCESS_TOKEN: 'oauth2-tok' };

type Env = NodeJS.ProcessEnv;
const env = (...groups: Record<string, string>[]): Env =>
  Object.assign({}, ...groups) as Env;

// ─── Table-driven inference: capability × env combo → mode | throws ──────────────

interface Case {
  name: string;
  env: Env;
  opts: {
    authMode?: AuthMode;
    needsWrite?: boolean;
    needsUser?: boolean;
    needsBookmark?: boolean;
    needsStream?: boolean;
  };
  expectMode?: AuthMode;
  expectThrow?: boolean;
}

const cases: Case[] = [
  // ── READ (needs nothing special) ──────────────────────────────────────────────
  { name: 'read: bearer present → bearer', env: env(BEARER), opts: {}, expectMode: 'bearer' },
  {
    name: 'read: bearer preferred over user tokens',
    env: env(BEARER, OAUTH1, OAUTH2),
    opts: {},
    expectMode: 'bearer',
  },
  {
    name: 'read: no bearer, oauth1 present → oauth1 (user fallback)',
    env: env(OAUTH1),
    opts: {},
    expectMode: 'oauth1',
  },
  {
    name: 'read: no bearer, only oauth2 → oauth2 (user fallback)',
    env: env(OAUTH2),
    opts: {},
    expectMode: 'oauth2',
  },
  {
    name: 'read: no bearer, both user tokens → oauth1 (tie-break)',
    env: env(OAUTH1, OAUTH2),
    opts: {},
    expectMode: 'oauth1',
  },
  { name: 'read: no creds at all → throws', env: env(), opts: {}, expectThrow: true },

  // ── WRITE (needs user context; locked decision #1 → prefer oauth1) ──────────────
  {
    name: 'write: oauth1 only → oauth1',
    env: env(OAUTH1),
    opts: { needsWrite: true },
    expectMode: 'oauth1',
  },
  {
    name: 'write: oauth2 only → oauth2',
    env: env(OAUTH2),
    opts: { needsWrite: true },
    expectMode: 'oauth2',
  },
  {
    name: 'write: BOTH present → oauth1 (LOCKED DECISION #1)',
    env: env(OAUTH1, OAUTH2),
    opts: { needsWrite: true },
    expectMode: 'oauth1',
  },
  {
    name: 'write: bearer only → throws (app-only rejected for writes)',
    env: env(BEARER),
    opts: { needsWrite: true },
    expectThrow: true,
  },
  {
    name: 'write: bearer + oauth2 → oauth2 (bearer ignored, user token used)',
    env: env(BEARER, OAUTH2),
    opts: { needsWrite: true },
    expectMode: 'oauth2',
  },
  {
    name: 'write: partial oauth1 (missing secret) + no oauth2 → throws',
    env: env({ X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at' }),
    opts: { needsWrite: true },
    expectThrow: true,
  },

  // ── USER-CONTEXT READ (needsUser: user token required, prefer oauth1) ───────────
  {
    name: 'user: oauth1 only → oauth1',
    env: env(OAUTH1),
    opts: { needsUser: true },
    expectMode: 'oauth1',
  },
  {
    name: 'user: oauth2 only → oauth2',
    env: env(OAUTH2),
    opts: { needsUser: true },
    expectMode: 'oauth2',
  },
  {
    name: 'user: BOTH present → oauth1 (tie-break)',
    env: env(OAUTH1, OAUTH2),
    opts: { needsUser: true },
    expectMode: 'oauth1',
  },
  {
    name: 'user: bearer only → throws (app-only rejected for user-context reads)',
    env: env(BEARER),
    opts: { needsUser: true },
    expectThrow: true,
  },
  {
    name: 'user: bearer + oauth2 → oauth2 (bearer ignored, user token used)',
    env: env(BEARER, OAUTH2),
    opts: { needsUser: true },
    expectMode: 'oauth2',
  },
  {
    name: 'user: no creds → throws',
    env: env(),
    opts: { needsUser: true },
    expectThrow: true,
  },

  // ── BOOKMARK (oauth2 only) ──────────────────────────────────────────────────────
  {
    name: 'bookmark: oauth2 present → oauth2',
    env: env(OAUTH2),
    opts: { needsBookmark: true },
    expectMode: 'oauth2',
  },
  {
    name: 'bookmark: oauth1 present but no oauth2 → throws (oauth2-only)',
    env: env(OAUTH1),
    opts: { needsBookmark: true },
    expectThrow: true,
  },
  {
    name: 'bookmark: bearer only → throws',
    env: env(BEARER),
    opts: { needsBookmark: true },
    expectThrow: true,
  },

  // ── STREAM / full-archive (bearer only) ─────────────────────────────────────────
  {
    name: 'stream: bearer present → bearer',
    env: env(BEARER),
    opts: { needsStream: true },
    expectMode: 'bearer',
  },
  {
    name: 'stream: user tokens but no bearer → throws (bearer-only)',
    env: env(OAUTH1, OAUTH2),
    opts: { needsStream: true },
    expectThrow: true,
  },

  // ── FORCED --auth ────────────────────────────────────────────────────────────────
  {
    name: 'forced bearer with bearer present → bearer',
    env: env(BEARER, OAUTH1),
    opts: { authMode: 'bearer' },
    expectMode: 'bearer',
  },
  {
    name: 'forced bearer without bearer → throws',
    env: env(OAUTH1),
    opts: { authMode: 'bearer' },
    expectThrow: true,
  },
  {
    name: 'forced oauth1 with all 4 → oauth1',
    env: env(OAUTH1),
    opts: { authMode: 'oauth1' },
    expectMode: 'oauth1',
  },
  {
    name: 'forced oauth1 missing a var → throws',
    env: env({ X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at' }),
    opts: { authMode: 'oauth1' },
    expectThrow: true,
  },
  {
    name: 'forced oauth2 with token → oauth2',
    env: env(OAUTH2),
    opts: { authMode: 'oauth2' },
    expectMode: 'oauth2',
  },
  {
    name: 'forced oauth2 without token → throws',
    env: env(BEARER),
    opts: { authMode: 'oauth2' },
    expectThrow: true,
  },
  {
    name: 'forced bearer even for a write (explicit override) → bearer',
    env: env(BEARER),
    opts: { authMode: 'bearer', needsWrite: true },
    expectMode: 'bearer',
  },
];

describe('resolveConfig (table-driven)', () => {
  for (const c of cases) {
    it(c.name, () => {
      if (c.expectThrow) {
        expect(() => resolveConfig(c.env, c.opts)).toThrow(MissingCredentialsError);
      } else {
        const cfg = resolveConfig(c.env, c.opts);
        expect(cfg.authMode).toBe(c.expectMode);
      }
    });
  }
});

// ─── Config population + base URL ────────────────────────────────────────────────

describe('resolveConfig population', () => {
  it('populates only the relevant creds for bearer', () => {
    const cfg = resolveConfig(env(BEARER, OAUTH2), {});
    expect(cfg.bearerToken).toBe('bearer-tok');
    expect(cfg.oauth1).toBeUndefined();
    expect(cfg.oauth2AccessToken).toBeUndefined();
  });

  it('populates the full oauth1 cred set', () => {
    const cfg = resolveConfig(env(OAUTH1), { needsWrite: true });
    expect(cfg.oauth1).toEqual({
      apiKey: 'ck',
      apiSecret: 'cs',
      accessToken: 'at',
      accessTokenSecret: 'ats',
    });
    expect(cfg.bearerToken).toBeUndefined();
    expect(cfg.oauth2AccessToken).toBeUndefined();
  });

  it('populates only the oauth2 token for oauth2', () => {
    const cfg = resolveConfig(env(OAUTH2), { needsWrite: true });
    expect(cfg.oauth2AccessToken).toBe('oauth2-tok');
    expect(cfg.oauth1).toBeUndefined();
  });

  it('passes X_API_BASE_URL through as baseUrl', () => {
    const cfg = resolveConfig(env(BEARER, { X_API_BASE_URL: 'https://api.twitter.com/2' }), {});
    expect(cfg.baseUrl).toBe('https://api.twitter.com/2');
  });

  it('leaves baseUrl undefined when X_API_BASE_URL is unset (client defaults it)', () => {
    const cfg = resolveConfig(env(BEARER), {});
    expect(cfg.baseUrl).toBeUndefined();
  });
});

// ─── Error messages name the exact env vars ──────────────────────────────────────

describe('MissingCredentialsError messages', () => {
  it('read with no creds names all three groups', () => {
    try {
      resolveConfig(env(), {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingCredentialsError);
      const msg = (e as Error).message;
      expect(msg).toContain('X_BEARER_TOKEN');
      expect(msg).toContain('X_OAUTH2_ACCESS_TOKEN');
      expect(msg).toContain('X_API_KEY');
    }
  });

  it('write with bearer-only names the write cred options', () => {
    try {
      resolveConfig(env(BEARER), { needsWrite: true });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('X_API_KEY');
      expect(msg).toContain('X_OAUTH2_ACCESS_TOKEN');
    }
  });

  it('user-context read with bearer-only names the user-token options and rejects Bearer', () => {
    try {
      resolveConfig(env(BEARER), { needsUser: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingCredentialsError);
      const msg = (e as Error).message;
      expect(msg).toContain('X_API_KEY');
      expect(msg).toContain('X_OAUTH2_ACCESS_TOKEN');
      expect(msg).toContain('X_BEARER_TOKEN'); // names it as rejected
    }
  });

  it('bookmark names X_OAUTH2_ACCESS_TOKEN specifically', () => {
    try {
      resolveConfig(env(OAUTH1), { needsBookmark: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('X_OAUTH2_ACCESS_TOKEN');
    }
  });

  it('stream names X_BEARER_TOKEN specifically', () => {
    try {
      resolveConfig(env(OAUTH2), { needsStream: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('X_BEARER_TOKEN');
    }
  });

  it('forced oauth1 missing vars names which vars', () => {
    try {
      resolveConfig(env({ X_API_KEY: 'ck' }), { authMode: 'oauth1' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('X_API_SECRET');
      expect(msg).toContain('X_ACCESS_TOKEN');
    }
  });

  it('MissingCredentialsError is a UsageError', () => {
    try {
      resolveConfig(env(), {});
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
    }
  });
});

// ─── makeClient ───────────────────────────────────────────────────────────────────

describe('makeClient', () => {
  it('returns a configured XClient (no network)', () => {
    const client = makeClient(env(BEARER), {});
    expect(client).toBeInstanceOf(XClient);
  });

  it('propagates MissingCredentialsError from resolveConfig', () => {
    expect(() => makeClient(env(), { needsWrite: true })).toThrow(MissingCredentialsError);
  });
});
