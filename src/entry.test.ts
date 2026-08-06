import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from './entry.js';

/**
 * These tests exist because `isEntryPoint` gates `applyEnvFiles(process.env)` in cli.ts.
 * A false positive rewrites an unrelated host process's environment, so both directions
 * matter: the symlinked-bin case MUST stay true (it is the whole reason the old loose
 * `endsWith('cli.js')` fallback existed) and the lookalike case MUST be false.
 */

let dir: string;
let realScript: string; // <dir>/pkg/dist/cli.js  — the actual module
let binLink: string; // <dir>/bin/x           — symlink npm creates for `bin`
let lookalike: string; // <dir>/other/cli.js     — an UNRELATED tool's entry

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'x-entry-'));
  mkdirSync(join(dir, 'pkg', 'dist'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'other'), { recursive: true });

  realScript = join(dir, 'pkg', 'dist', 'cli.js');
  binLink = join(dir, 'bin', 'x');
  lookalike = join(dir, 'other', 'cli.js');

  writeFileSync(realScript, '// entry\n');
  writeFileSync(lookalike, '// a different tool that happens to be named cli.js\n');
  symlinkSync(realScript, binLink);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isEntryPoint', () => {
  it('is true when argv[1] is exactly this module (direct `node dist/cli.js`)', () => {
    expect(isEntryPoint(pathToFileURL(realScript).href, realScript)).toBe(true);
  });

  it('is true through a symlinked bin — the installed `x` case', () => {
    // npm/pnpm link `bin.x` into a bin dir; node reports the SYMLINK in argv[1] but the
    // RESOLVED target in import.meta.url. Realpathing both sides is what keeps this true.
    expect(isEntryPoint(pathToFileURL(realScript).href, binLink)).toBe(true);
  });

  it('is FALSE for an unrelated script that merely ends in cli.js', () => {
    // The regression this change exists to prevent: the old guard matched on
    // `argv[1].endsWith('cli.js')`, so this host would have had its env mutated.
    expect(isEntryPoint(pathToFileURL(realScript).href, lookalike)).toBe(false);
  });

  it('is false when imported by a test runner (argv[1] is the runner)', () => {
    expect(isEntryPoint(pathToFileURL(realScript).href, join(dir, 'bin', 'vitest.mjs'))).toBe(
      false,
    );
  });

  it('is false when argv[1] is absent or empty', () => {
    const url = pathToFileURL(realScript).href;
    expect(isEntryPoint(url, undefined)).toBe(false);
    expect(isEntryPoint(url, '')).toBe(false);
  });

  it('fails closed when argv[1] does not resolve to a real file', () => {
    expect(isEntryPoint(pathToFileURL(realScript).href, join(dir, 'nope', 'cli.js'))).toBe(false);
  });

  it('handles a path containing spaces, which the old `file://` concat did not', () => {
    const spaced = join(dir, 'pkg', 'dist', 'has space.js');
    writeFileSync(spaced, '// entry\n');
    // The removed check built `file://${argv[1]}` by hand, skipping URL encoding, so a
    // space made the string compare fail even for a genuine entry point.
    expect(isEntryPoint(pathToFileURL(spaced).href, spaced)).toBe(true);
  });
});
