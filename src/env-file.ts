import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * `.env` file loading — the ONLY module that touches the filesystem for credentials.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────────
 * `x` is installed globally (package.json `bin`), so credentials must come from
 * somewhere other than the shell you happen to be in. This module layers env files
 * UNDER the real `process.env`, so an exported shell var always wins and a file is
 * only ever a fallback. Nothing here reads `process.env` implicitly: the target env
 * is injected, which keeps {@link applyEnvFiles} testable and keeps `resolveConfig`
 * (auth.ts) pure.
 *
 * ─── Precedence (highest first) ───────────────────────────────────────────────────
 *   1. real process.env               — an exported shell var ALWAYS wins
 *   2. $X_ENV_FILE                    — explicit override (a file path)
 *   3. ./.env                         — project-local, relative to cwd
 *   4. $AFK_HOME/config/afk.env       — shared agent-afk env ($AFK_HOME default ~/.afk)
 *   5. ~/.afk.env                     — legacy agent-afk location
 * First file to define a key wins; later files never clobber an earlier one.
 *
 * A pre-existing value that is EMPTY or whitespace-only counts as absent, so a stray
 * `export X_BEARER_TOKEN=` in a shell profile cannot permanently shadow a real file
 * value. (agent-afk hit exactly this bug; see its `_clearBlankEnvShadows`.)
 *
 * ─── Compatibility ────────────────────────────────────────────────────────────────
 * {@link parseEnvFile} matches `dotenv@16` semantics (agent-afk's parser) so the same
 * `afk.env` behaves identically in both tools: optional `export ` prefix, single /
 * double / backtick quotes, `\n`+`\r` escapes inside double quotes only, full-line and
 * trailing `#` comments, silent skip of malformed lines. Deliberately dependency-free —
 * `zod` is this package's only runtime dep and that is worth keeping.
 */

/** A key is `[\w.-]+`, matching dotenv's key charset exactly. */
const KEY_RE = /^[\w.-]+$/;
const QUOTES = ['"', "'", '`'] as const;

/** Result of loading one candidate file. */
export interface EnvFileResult {
  path: string;
  /** false when the file is absent or unreadable (both are non-fatal). */
  loaded: boolean;
  /** Keys this file actually contributed to the target env. */
  applied: string[];
  /** Keys this file defined but that were already set with a higher precedence. */
  shadowed: string[];
  /** Present only when the file existed but could not be read/parsed. */
  error?: string;
}

export interface EnvFileReport {
  results: EnvFileResult[];
}

export interface ApplyEnvFilesOpts {
  /** Working directory for the `./.env` candidate. Default `process.cwd()`. */
  cwd?: string;
  /** Home directory for the `~/.afk*` candidates. Default `os.homedir()`. */
  home?: string;
  /** Explicit candidate list; bypasses {@link envFileCandidates}. For tests. */
  files?: string[];
  /** Injected reader; lets tests avoid the filesystem. */
  readFile?: (path: string) => string;
}

/**
 * Parses env-file text into a plain object. PURE — no fs, no process.env.
 *
 * Malformed lines are skipped silently (never throws), matching dotenv: a file with one
 * bad line still yields every good line.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip a UTF-8 BOM, then normalise CRLF so quote scanning is line-oriented.
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (!line || line.startsWith('#')) continue;

    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq <= 0) continue; // no `=`, or a line starting with `=`

    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;

    const rawValue = body.slice(eq + 1).trim();
    const quote = QUOTES.find((q) => rawValue.startsWith(q));

    if (quote === undefined) {
      // Unquoted: a `#` ends the value (dotenv's `[^#\r\n]*`), then trim.
      const hash = rawValue.indexOf('#');
      out[key] = (hash === -1 ? rawValue : rawValue.slice(0, hash)).trim();
      continue;
    }

    // Quoted: find the closing quote, spanning lines if needed.
    const close = rawValue.indexOf(quote, 1);
    if (close !== -1) {
      out[key] = unescape(rawValue.slice(1, close), quote);
      continue;
    }

    const chunks = [rawValue.slice(1)];
    let closedAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      const idx = next.indexOf(quote);
      if (idx === -1) {
        chunks.push(next);
        continue;
      }
      chunks.push(next.slice(0, idx));
      closedAt = j;
      break;
    }

    if (closedAt === -1) {
      // Unterminated quote: dotenv falls back to the unquoted branch (quote retained).
      out[key] = rawValue;
      continue;
    }
    out[key] = unescape(chunks.join('\n'), quote);
    i = closedAt; // resume after the closing line
  }

  return out;
}

/** `\n`/`\r` escapes expand inside DOUBLE quotes only — dotenv's rule. */
function unescape(value: string, quote: string): string {
  if (quote !== '"') return value;
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

/**
 * Builds the ordered candidate path list (highest precedence first). PURE.
 *
 * `$X_ENV_FILE` and `$AFK_HOME` are read from the injected env, not `process.env`, and
 * a relative `$X_ENV_FILE` resolves against `cwd`. Duplicate paths are collapsed so a
 * file is never parsed twice.
 */
export function envFileCandidates(env: NodeJS.ProcessEnv, cwd: string, home: string): string[] {
  const paths: string[] = [];

  const explicit = env['X_ENV_FILE'];
  if (explicit) paths.push(isAbsolute(explicit) ? explicit : resolve(cwd, explicit));

  paths.push(join(cwd, '.env'));

  const afkHome = env['AFK_HOME'];
  const afkRoot = afkHome && isAbsolute(afkHome) ? afkHome : join(home, '.afk');
  paths.push(join(afkRoot, 'config', 'afk.env'));
  paths.push(join(home, '.afk.env')); // legacy agent-afk location

  return [...new Set(paths)];
}

/**
 * Reads the candidate files and fills GAPS in `target` (mutates it in place), returning
 * a report of what came from where.
 *
 * Never throws: a missing, unreadable, or malformed file is recorded in the report and
 * skipped. Callers that need the report rendered can use {@link formatEnvFileReport}.
 */
export function applyEnvFiles(
  target: NodeJS.ProcessEnv,
  opts: ApplyEnvFilesOpts = {},
): EnvFileReport {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const files = opts.files ?? envFileCandidates(target, cwd, home);

  const results: EnvFileResult[] = [];

  for (const path of files) {
    const result: EnvFileResult = { path, loaded: false, applied: [], shadowed: [] };
    results.push(result);

    let contents: string;
    try {
      contents = read(path);
    } catch (err) {
      // ENOENT is the common, boring case: not an error worth surfacing.
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') result.error = describeError(err);
      continue;
    }
    result.loaded = true;

    for (const [key, value] of Object.entries(parseEnvFile(contents))) {
      if (isSet(target, key)) {
        result.shadowed.push(key);
        continue;
      }
      target[key] = value;
      result.applied.push(key);
    }
  }

  return { results };
}

/** A key counts as set only when it holds a non-blank value (see blank-shadow note). */
function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const current = env[key];
  return current !== undefined && current.trim() !== '';
}

function describeError(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Renders a report for `X_ENV_DEBUG=1`. Lists only KEY NAMES, never values, so it is
 * always safe to print to stderr.
 */
export function formatEnvFileReport(report: EnvFileReport): string {
  const lines = ['x: env file resolution (shell env always wins):'];
  for (const r of report.results) {
    if (!r.loaded) {
      lines.push(`  ${r.path} — ${r.error ? `unreadable (${r.error})` : 'not found'}`);
      continue;
    }
    const parts = [`applied ${r.applied.length}`];
    if (r.applied.length) parts.push(`[${r.applied.join(', ')}]`);
    if (r.shadowed.length) parts.push(`shadowed [${r.shadowed.join(', ')}]`);
    lines.push(`  ${r.path} — ${parts.join(' ')}`);
  }
  return lines.join('\n') + '\n';
}
