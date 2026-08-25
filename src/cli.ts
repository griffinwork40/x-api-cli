/**
 * x-api CLI entry point.
 *
 * tsup bundles this to `dist/cli.js` and prepends the `#!/usr/bin/env node` shebang
 * (see tsup.config.ts `banner`). The `x` bin maps here (package.json `bin`).
 *
 * Responsibilities:
 *   0. Layer `.env` files UNDER the real `process.env` (env-file.ts) — done ONLY in the
 *      entry guard at the bottom, never inside `runCli`, so unit tests that inject an
 *      env stay hermetic and never read the developer's real `~/.afk/config/afk.env`.
 *   1. Parse `process.argv` → `command` + `rest` (`rest[0]` = sub-action).
 *   2. `--help`/`-h`/no command → top-level usage (exit 0);
 *      `x <command> --help` → that command's `<NAME>_HELP` (exit 0).
 *   3. Dispatch table `command → { run, help }` for all 14 commands.
 *   4. Auth-needs resolver `(command, subAction) → ResolveOpts` (SOURCE OF TRUTH = PLAN §3).
 *   5. Build `cfg = resolveConfig(process.env, needs)` → `new XClient(cfg)` → `run(client, rest, cfg)`.
 *   6. Single top-level try/catch → exit codes (all stderr passes through `redactSecrets`):
 *        UsageError / MissingCredentialsError → exit 1
 *        RateLimitError                       → exit 3 ("rate limited, retry in Ns")
 *        XApiError                            → exit 1 (+ problem type / partial errors)
 *        anything else                        → exit 1
 *      Unknown command → UsageError.
 */

import type { AuthMode, XClientConfig } from './types.js';
import { XApiError } from './types.js';
import { UsageError, MissingCredentialsError, RateLimitError } from './errors.js';
import { resolveConfig } from './auth.js';
import { XClient } from './client.js';
import { redactSecrets, collectSecrets } from './redact.js';
import { applyEnvFiles, formatEnvFileReport } from './env-file.js';
import { isEntryPoint } from './entry.js';
import type { ResolveOpts } from './auth.js';

import { runTweet, TWEET_HELP } from './commands/tweet.js';
import { runSearch, SEARCH_HELP } from './commands/search.js';
import { runTimeline, TIMELINE_HELP } from './commands/timeline.js';
import { runUser, USER_HELP } from './commands/user.js';
import { runLike, LIKE_HELP } from './commands/like.js';
import { runRetweet, RETWEET_HELP } from './commands/retweet.js';
import { runFollow, FOLLOW_HELP } from './commands/follow.js';
import { runRelationship, RELATIONSHIP_HELP } from './commands/relationship.js';
import { runBookmark, BOOKMARK_HELP } from './commands/bookmark.js';
import { runList, LIST_HELP } from './commands/list.js';
import { runDm, DM_HELP } from './commands/dm.js';
import { runMedia, MEDIA_HELP } from './commands/media.js';
import { runSpace, SPACE_HELP } from './commands/space.js';
import { runAccount, ACCOUNT_HELP } from './commands/account.js';

// ─── Dispatch table ───────────────────────────────────────────────────────────────

type CommandFn = (client: XClient, args: string[], cfg: XClientConfig) => Promise<void>;

interface CommandEntry {
  run: CommandFn;
  help: string;
  /** One-line summary for the top-level usage listing. */
  summary: string;
}

const COMMANDS: Record<string, CommandEntry> = {
  tweet: { run: runTweet, help: TWEET_HELP, summary: 'Get, create, or delete Posts (tweets).' },
  search: { run: runSearch, help: SEARCH_HELP, summary: 'Search recent/full-archive Posts; counts.' },
  timeline: { run: runTimeline, help: TIMELINE_HELP, summary: "A user's Posts, mentions, or home timeline." },
  user: { run: runUser, help: USER_HELP, summary: 'Look up users; me; followers/following.' },
  like: { run: runLike, help: LIKE_HELP, summary: 'Like/unlike; liking-users; liked-tweets.' },
  retweet: { run: runRetweet, help: RETWEET_HELP, summary: 'Repost/undo; retweeted-by; quote-tweets.' },
  follow: { run: runFollow, help: FOLLOW_HELP, summary: 'Follow / unfollow a user.' },
  relationship: { run: runRelationship, help: RELATIONSHIP_HELP, summary: 'Mute/unmute and block/unblock users.' },
  bookmark: { run: runBookmark, help: BOOKMARK_HELP, summary: 'List/add/remove bookmarks (OAuth2 only).' },
  list: { run: runList, help: LIST_HELP, summary: 'Manage Lists and their members/tweets.' },
  dm: { run: runDm, help: DM_HELP, summary: 'Send DMs; create a group conversation.' },
  media: { run: runMedia, help: MEDIA_HELP, summary: 'Upload media (image one-shot / chunked video).' },
  space: { run: runSpace, help: SPACE_HELP, summary: 'Look up or search Spaces.' },
  account: { run: runAccount, help: ACCOUNT_HELP, summary: 'whoami (user context) + rate-limit probe.' },
};

// ─── Auth-needs resolver: (command, subAction) → ResolveOpts ────────────────────────
// SOURCE OF TRUTH = PLAN §3 endpoint→command→auth table (Wave C brief auth-needs map).
//   read           → no flags (prefer Bearer, fall back to any user token)
//   needsWrite     → user context (oauth1 preferred, else oauth2); Bearer rejected
//   needsUser      → user-context READ (oauth1/oauth2); Bearer rejected
//   needsBookmark  → oauth2 only
//   needsStream    → app-only Bearer only

const READ: ResolveOpts = {};
const WRITE: ResolveOpts = { needsWrite: true };
const USER: ResolveOpts = { needsUser: true };
const BOOKMARK: ResolveOpts = { needsBookmark: true };
const STREAM: ResolveOpts = { needsStream: true };

/**
 * Per-command sub-action → needs map. A `default` key supplies the fallback for a
 * command's default sub-action (e.g. `account` → `whoami`) and for any sub-action not
 * explicitly listed (the command itself throws a UsageError for a truly-unknown one,
 * but we still need a `needs` to build a client so that error can surface). Reads are
 * the safe default (they never over-demand credentials).
 */
const AUTH_NEEDS: Record<string, { default: ResolveOpts; sub?: Record<string, ResolveOpts> }> = {
  tweet: { default: READ, sub: { get: READ, create: WRITE, delete: WRITE } },
  search: { default: READ, sub: { recent: READ, all: STREAM, counts: READ } },
  timeline: { default: READ, sub: { posts: READ, mentions: READ, home: USER } },
  user: { default: READ, sub: { get: READ, me: USER, followers: READ, following: READ } },
  like: {
    default: READ,
    sub: { create: WRITE, delete: WRITE, 'liking-users': USER, 'liked-tweets': USER },
  },
  retweet: {
    default: READ,
    sub: { create: WRITE, delete: WRITE, 'retweeted-by': READ, 'quote-tweets': READ },
  },
  follow: { default: WRITE, sub: { follow: WRITE, unfollow: WRITE } },
  relationship: {
    default: WRITE,
    sub: { mute: WRITE, unmute: WRITE, block: WRITE, unblock: WRITE },
  },
  bookmark: { default: BOOKMARK, sub: { list: BOOKMARK, add: BOOKMARK, remove: BOOKMARK } },
  list: {
    default: READ,
    sub: {
      get: READ,
      tweets: READ,
      owned: READ,
      'members-list': READ,
      create: WRITE,
      update: WRITE,
      delete: WRITE,
      'members-add': WRITE,
      'members-remove': WRITE,
    },
  },
  dm: { default: WRITE, sub: { send: WRITE, 'create-conversation': WRITE } },
  media: { default: WRITE, sub: { upload: WRITE } },
  space: { default: READ, sub: { get: READ, search: READ } },
  account: { default: USER, sub: { whoami: USER, 'rate-limit': READ } },
};

/** Resolves the credential requirement for a (command, subAction) pair. */
function needsFor(command: string, subAction: string | undefined): ResolveOpts {
  const entry = AUTH_NEEDS[command];
  if (!entry) return READ; // unknown command handled by the caller before this is used
  if (subAction !== undefined && entry.sub && entry.sub[subAction]) {
    return entry.sub[subAction]!;
  }
  return entry.default;
}

// ─── Usage text ─────────────────────────────────────────────────────────────────

function topLevelUsage(): string {
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => n.length));
  const lines = names.map((n) => `  ${n.padEnd(width)}  ${COMMANDS[n]!.summary}`);
  return [
    'x — a lightweight CLI for the X API (Twitter API v2).',
    '',
    'Usage: x <command> <subcommand> [flags]',
    '       x <command> --help        show a command\'s subcommands & flags',
    '       x --help                  show this message',
    '',
    'Commands:',
    ...lines,
    '',
    'Global flags:',
    '  --auth <bearer|oauth1|oauth2>  force an auth mode (else inferred from env)',
    '',
    'Auth (env): X_BEARER_TOKEN (reads) · X_API_KEY/SECRET + X_ACCESS_TOKEN/SECRET (OAuth1)',
    '            · X_OAUTH2_ACCESS_TOKEN (OAuth2). See README.md / SKILL.md.',
    '',
    'Env files (loaded in order; the shell env and then the FIRST file to set a key win):',
    '  $X_ENV_FILE  ·  ./.env  ·  $AFK_HOME/config/afk.env (default ~/.afk)  ·  ~/.afk.env',
    '  Set X_ENV_DEBUG=1 to print which file supplied which var (names only, no values).',
  ].join('\n');
}

// ─── --auth extraction ──────────────────────────────────────────────────────────

const VALID_AUTH_MODES: readonly AuthMode[] = ['bearer', 'oauth1', 'oauth2'];

/**
 * Extracts a global `--auth <mode>` (or `--auth=<mode>`) from an argv slice, returning
 * the mode and the remaining args (with `--auth` removed) so the command's own
 * `strict` parseArgs never sees it. Throws UsageError on an invalid/absent value.
 */
function extractAuthMode(args: string[]): { authMode?: AuthMode; rest: string[] } {
  const rest: string[] = [];
  let authMode: AuthMode | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--auth') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError('--auth requires a value: bearer, oauth1, or oauth2.');
      }
      if (!VALID_AUTH_MODES.includes(value as AuthMode)) {
        throw new UsageError(`invalid --auth '${value}'. Expected: bearer, oauth1, or oauth2.`);
      }
      authMode = value as AuthMode;
      i += 1; // skip the value
    } else if (arg.startsWith('--auth=')) {
      const value = arg.slice('--auth='.length);
      if (!VALID_AUTH_MODES.includes(value as AuthMode)) {
        throw new UsageError(`invalid --auth '${value}'. Expected: bearer, oauth1, or oauth2.`);
      }
      authMode = value as AuthMode;
    } else {
      rest.push(arg);
    }
  }

  return authMode !== undefined ? { authMode, rest } : { rest };
}

// ─── Error → exit-code mapping (all stderr redacted) ────────────────────────────────

function emit(message: string, secrets: string[]): void {
  process.stderr.write(redactSecrets(message, secrets) + '\n');
}

/** Maps a caught error to an exit code, writing a redacted message to stderr. */
function reportError(err: unknown, secrets: string[]): number {
  // MissingCredentialsError is a UsageError subclass — the UsageError branch covers both.
  if (err instanceof UsageError) {
    emit(err.message, secrets);
    return 1;
  }
  if (err instanceof RateLimitError) {
    emit(`rate limited, retry in ${err.resetInSeconds}s`, secrets);
    return 3;
  }
  if (err instanceof XApiError) {
    const parts = [`HTTP ${err.status}: ${err.message}`];
    const suffix = err.problemTypeSuffix();
    if (suffix) parts.push(`(problem type: ${suffix})`);
    if (err.partialErrors && err.partialErrors.length > 0) {
      parts.push(`partial errors: ${JSON.stringify(err.partialErrors)}`);
    }
    emit(parts.join(' '), secrets);
    return 1;
  }
  emit(err instanceof Error ? err.message : String(err), secrets);
  return 1;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

/**
 * Runs the CLI for a given argv. Populates `secretsSink` with the resolved config's
 * secrets AS SOON as a config is built, so the top-level catch can redact a message
 * from an error thrown later (during `run()`) even though it never sees `cfg` directly.
 * Returns the process exit code. Exported for `cli.test.ts`.
 */
export async function runCli(argv: string[], secretsSink: { secrets: string[] }): Promise<number> {
  const [, , command, ...rawRest] = argv;

  // Top-level help / no command.
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(topLevelUsage() + '\n');
    return 0;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    // Unknown command → UsageError (exit 1). No creds resolved, so no secrets to redact.
    throw new UsageError(`unknown command '${command}'.\n\n${topLevelUsage()}`);
  }

  // `x <command> --help` / `-h` → that command's help, exit 0 (before any auth).
  if (rawRest.includes('--help') || rawRest.includes('-h')) {
    process.stdout.write(entry.help + '\n');
    return 0;
  }

  // Strip the global --auth flag so the command's strict parser never sees it.
  const { authMode, rest } = extractAuthMode(rawRest);
  const subAction = rest[0];

  // Resolve credentials for this (command, subAction) — throws MissingCredentialsError
  // BEFORE any network call when the required creds are absent.
  const needs: ResolveOpts = { ...needsFor(command, subAction) };
  if (authMode !== undefined) needs.authMode = authMode;

  const cfg = resolveConfig(process.env, needs);
  // Record secrets now so a later-thrown XApiError/RateLimitError message is redactable.
  secretsSink.secrets = collectSecrets(cfg);

  const client = new XClient(cfg);
  await entry.run(client, rest, cfg);
  return 0;
}

// Only auto-run when executed as the entry (not when imported by a test or a host).
// Exact, realpath-resolved identity — see entry.ts for why a suffix match is unsafe
// now that this block mutates `process.env`.
const isEntry = isEntryPoint(import.meta.url, process.argv[1]);

if (isEntry) {
  // Fill env gaps from `.env` files BEFORE anything reads credentials. Deliberately
  // here and not inside runCli: tests import runCli with an injected env and must not
  // pick up the developer's real files. Shell exports always win (see env-file.ts).
  const envReport = applyEnvFiles(process.env);
  if (process.env['X_ENV_DEBUG'] === '1') {
    process.stderr.write(formatEnvFileReport(envReport));
  }

  const sink = { secrets: [] as string[] };
  runCli(process.argv, sink)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.exitCode = reportError(err, sink.secrets);
    });
}
