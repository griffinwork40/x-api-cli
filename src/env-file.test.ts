import { describe, it, expect } from 'vitest';
import {
  parseEnvFile,
  envFileCandidates,
  applyEnvFiles,
  formatEnvFileReport,
} from './env-file.js';

// ─── parseEnvFile — dotenv@16 compatibility ───────────────────────────────────────

describe('parseEnvFile', () => {
  it('parses plain KEY=value', () => {
    expect(parseEnvFile('X_BEARER_TOKEN=abc123')).toEqual({ X_BEARER_TOKEN: 'abc123' });
  });

  it('strips an optional `export ` prefix', () => {
    expect(parseEnvFile('export X_API_KEY=k1')).toEqual({ X_API_KEY: 'k1' });
  });

  it('trims whitespace around key and value', () => {
    expect(parseEnvFile('  X_API_KEY   =   k1   ')).toEqual({ X_API_KEY: 'k1' });
  });

  it('skips blank lines and full-line comments', () => {
    const out = parseEnvFile('# a comment\n\n   \nX_API_KEY=k1\n# trailing comment');
    expect(out).toEqual({ X_API_KEY: 'k1' });
  });

  it('strips a trailing inline comment from an UNQUOTED value', () => {
    expect(parseEnvFile('X_API_KEY=k1 # my key')).toEqual({ X_API_KEY: 'k1' });
    // dotenv stops at `#` even with no preceding space
    expect(parseEnvFile('X_API_KEY=k1#k2')).toEqual({ X_API_KEY: 'k1' });
  });

  it('keeps `#` inside a quoted value', () => {
    expect(parseEnvFile('X_API_KEY="k#1"')).toEqual({ X_API_KEY: 'k#1' });
    expect(parseEnvFile("X_API_KEY='k#1'")).toEqual({ X_API_KEY: 'k#1' });
  });

  it('strips one matching pair of single, double, or backtick quotes', () => {
    expect(parseEnvFile('A="v"\nB=\'v\'\nC=`v`')).toEqual({ A: 'v', B: 'v', C: 'v' });
  });

  it('expands \\n and \\r inside DOUBLE quotes only', () => {
    expect(parseEnvFile('A="l1\\nl2"')).toEqual({ A: 'l1\nl2' });
    expect(parseEnvFile("A='l1\\nl2'")).toEqual({ A: 'l1\\nl2' });
    expect(parseEnvFile('A=l1\\nl2')).toEqual({ A: 'l1\\nl2' });
  });

  it('supports a quoted value spanning multiple lines', () => {
    const out = parseEnvFile('KEY="line1\nline2"\nNEXT=after');
    expect(out).toEqual({ KEY: 'line1\nline2', NEXT: 'after' });
  });

  it('falls back to the literal (quote retained) on an unterminated quote', () => {
    expect(parseEnvFile('KEY="oops')).toEqual({ KEY: '"oops' });
  });

  it('preserves an explicitly empty value', () => {
    expect(parseEnvFile('KEY=')).toEqual({ KEY: '' });
    expect(parseEnvFile('KEY=""')).toEqual({ KEY: '' });
  });

  it('skips malformed lines without throwing, keeping the good ones', () => {
    const out = parseEnvFile('garbage-no-equals\n=novalue\nbad key=v\nGOOD=v');
    expect(out).toEqual({ GOOD: 'v' });
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    expect(parseEnvFile('\uFEFFA=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('lets a later duplicate key win within one file', () => {
    expect(parseEnvFile('A=first\nA=second')).toEqual({ A: 'second' });
  });
});

// ─── envFileCandidates — precedence order ─────────────────────────────────────────

describe('envFileCandidates', () => {
  it('orders X_ENV_FILE, cwd/.env, afk.env, then the legacy path', () => {
    const out = envFileCandidates({ X_ENV_FILE: '/tmp/custom.env' }, '/proj', '/home/me');
    expect(out).toEqual([
      '/tmp/custom.env',
      '/proj/.env',
      '/home/me/.afk/config/afk.env',
      '/home/me/.afk.env',
    ]);
  });

  it('omits X_ENV_FILE when unset', () => {
    expect(envFileCandidates({}, '/proj', '/home/me')).toEqual([
      '/proj/.env',
      '/home/me/.afk/config/afk.env',
      '/home/me/.afk.env',
    ]);
  });

  it('resolves a relative X_ENV_FILE against cwd', () => {
    const out = envFileCandidates({ X_ENV_FILE: 'cfg/.env' }, '/proj', '/home/me');
    expect(out[0]).toBe('/proj/cfg/.env');
  });

  it('honours an absolute AFK_HOME override', () => {
    const out = envFileCandidates({ AFK_HOME: '/opt/afk' }, '/proj', '/home/me');
    expect(out).toContain('/opt/afk/config/afk.env');
  });

  it('ignores a relative AFK_HOME (falls back to ~/.afk), matching agent-afk', () => {
    const out = envFileCandidates({ AFK_HOME: 'relative' }, '/proj', '/home/me');
    expect(out).toContain('/home/me/.afk/config/afk.env');
  });

  it('collapses duplicate paths so a file is never parsed twice', () => {
    const out = envFileCandidates({ X_ENV_FILE: '/proj/.env' }, '/proj', '/home/me');
    expect(out.filter((p) => p === '/proj/.env')).toHaveLength(1);
  });
});

// ─── applyEnvFiles — layering + precedence ────────────────────────────────────────

describe('applyEnvFiles', () => {
  /** Builds a fake reader over an in-memory {path: contents} map. */
  const reader = (fs: Record<string, string>) => (p: string) => {
    const hit = fs[p];
    if (hit === undefined) {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }
    return hit;
  };

  it('fills gaps in the target env', () => {
    const env: NodeJS.ProcessEnv = {};
    applyEnvFiles(env, { files: ['/a'], readFile: reader({ '/a': 'X_BEARER_TOKEN=fromfile' }) });
    expect(env['X_BEARER_TOKEN']).toBe('fromfile');
  });

  it('NEVER overrides a value already set in the target env', () => {
    const env: NodeJS.ProcessEnv = { X_BEARER_TOKEN: 'fromshell' };
    const report = applyEnvFiles(env, {
      files: ['/a'],
      readFile: reader({ '/a': 'X_BEARER_TOKEN=fromfile' }),
    });
    expect(env['X_BEARER_TOKEN']).toBe('fromshell');
    expect(report.results[0]!.shadowed).toEqual(['X_BEARER_TOKEN']);
    expect(report.results[0]!.applied).toEqual([]);
  });

  it('treats a blank/whitespace pre-existing value as absent (blank-shadow fix)', () => {
    const env: NodeJS.ProcessEnv = { X_BEARER_TOKEN: '', X_API_KEY: '   ' };
    applyEnvFiles(env, {
      files: ['/a'],
      readFile: reader({ '/a': 'X_BEARER_TOKEN=real\nX_API_KEY=alsoreal' }),
    });
    expect(env['X_BEARER_TOKEN']).toBe('real');
    expect(env['X_API_KEY']).toBe('alsoreal');
  });

  it('gives the EARLIER file precedence over a later one', () => {
    const env: NodeJS.ProcessEnv = {};
    applyEnvFiles(env, {
      files: ['/local/.env', '/home/.afk/config/afk.env'],
      readFile: reader({
        '/local/.env': 'X_BEARER_TOKEN=local',
        '/home/.afk/config/afk.env': 'X_BEARER_TOKEN=afk\nX_API_KEY=afkonly',
      }),
    });
    expect(env['X_BEARER_TOKEN']).toBe('local');
    // a key only the later file defines still lands
    expect(env['X_API_KEY']).toBe('afkonly');
  });

  it('is silent and non-fatal when every candidate is missing', () => {
    const env: NodeJS.ProcessEnv = {};
    const report = applyEnvFiles(env, { files: ['/nope'], readFile: reader({}) });
    expect(env).toEqual({});
    expect(report.results[0]).toMatchObject({ loaded: false });
    expect(report.results[0]!.error).toBeUndefined(); // ENOENT is not an error
  });

  it('records a non-ENOENT read failure without throwing', () => {
    const env: NodeJS.ProcessEnv = {};
    const report = applyEnvFiles(env, {
      files: ['/denied'],
      readFile: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });
    expect(report.results[0]).toMatchObject({ loaded: false, error: 'EACCES' });
  });

  it('derives candidates from the injected env/cwd/home when `files` is omitted', () => {
    const env: NodeJS.ProcessEnv = { AFK_HOME: '/opt/afk' };
    const report = applyEnvFiles(env, { cwd: '/proj', home: '/home/me', readFile: reader({}) });
    expect(report.results.map((r) => r.path)).toEqual([
      '/proj/.env',
      '/opt/afk/config/afk.env',
      '/home/me/.afk.env',
    ]);
  });
});

// ─── formatEnvFileReport — must never leak values ─────────────────────────────────

describe('formatEnvFileReport', () => {
  it('lists key names and file states but never values', () => {
    const env: NodeJS.ProcessEnv = { X_API_KEY: 'shellvalue' };
    const report = applyEnvFiles(env, {
      files: ['/a', '/missing'],
      readFile: (p) => {
        if (p === '/a') return 'X_BEARER_TOKEN=SUPERSECRET\nX_API_KEY=ALSOSECRET';
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    const text = formatEnvFileReport(report);
    expect(text).toContain('X_BEARER_TOKEN');
    expect(text).toContain('shadowed [X_API_KEY]');
    expect(text).toContain('/missing — not found');
    expect(text).not.toContain('SUPERSECRET');
    expect(text).not.toContain('ALSOSECRET');
    expect(text).not.toContain('shellvalue');
  });
});
