# x-api

A lightweight CLI wrapper for the **X API (Twitter API v2)** — read (tweet/user/search/timeline/space lookups), write (post, like, retweet, follow, mute, block, bookmark, list, DM), and media upload. Zero runtime dependencies beyond `zod`; OAuth 1.0a signing uses Node's built-in `node:crypto`, HTTP uses the global `fetch` (Node ≥18).

## Install

```bash
pnpm install
```

## Build

```bash
pnpm build            # tsup → dist/cli.js (with a #!/usr/bin/env node shebang)
```

The build emits `dist/cli.js`. `package.json` maps the `x` bin to it, so after `pnpm link --global` (or `npm i -g .`) you can invoke `x <command>`; otherwise run it directly:

```bash
node dist/cli.js <command> <subcommand> [flags]
# e.g.
node dist/cli.js --help
node dist/cli.js tweet get --id 20
```

## Authentication

Credentials come from the X Developer Console → your App → **Keys & Tokens** (<https://console.x.com/>). Set the environment variables for the group(s) you need (copy `.env.example` → `.env`):

| Var group | Auth mode | Enables |
|---|---|---|
| `X_BEARER_TOKEN` | App-only **Bearer** | Public reads (tweets/users/search/timeline/spaces), full-archive search & counts, streams. **No** user actions. |
| `X_API_KEY` + `X_API_SECRET` + `X_ACCESS_TOKEN` + `X_ACCESS_TOKEN_SECRET` | **OAuth 1.0a** user context | Post/delete, like, retweet, follow, mute, block, lists, DMs, media, `/2/users/me`. (All four required together.) |
| `X_OAUTH2_ACCESS_TOKEN` | **OAuth 2.0** user token | Same user actions as OAuth 1.0a **plus bookmarks** (bookmarks are OAuth2-only). |
| `X_API_BASE_URL` *(optional)* | — | Override base URL (default `https://api.x.com/2`; e.g. the legacy host `https://api.twitter.com/2`, or a mock). |

> **Note:** `X_BEARER_TOKEN` (app identity) and `X_OAUTH2_ACCESS_TOKEN` (user identity) both ride in `Authorization: Bearer …` but are **different identities** — keep them in separate vars, never swap.

### Auth-mode selection rules

The CLI chooses a mode from the (command, sub-action) it's running plus what's in the environment:

- **Reads** (tweet get, user get, search recent/counts, timelines posts/mentions, retweet reads, list reads, space) → prefer **Bearer**; fall back to any user token if no Bearer.
- **Writes** (create/delete tweet, like, retweet, follow, mute/block, list mutations, DM send, media upload) → require a **user context**: OAuth 1.0a (all four vars) **or** OAuth 2.0. App-only Bearer is **rejected**. When both are present, OAuth 1.0a is preferred (console tokens don't expire).
- **User-context reads** (`users/me`, home timeline, liking-users, liked-tweets, `account whoami`) → require a **user token** (OAuth1 preferred, else OAuth2); Bearer is rejected.
- **Bookmarks** (`bookmark list/add/remove`) → **OAuth 2.0 only** (`X_OAUTH2_ACCESS_TOKEN`).
- **Full-archive search & counts** (`search all`, `search counts`) → **app-only Bearer only**.
- Force a mode with the global flag `--auth bearer|oauth1|oauth2` (errors if that mode's creds are absent).

If the required creds are missing, the CLI exits **1** with a `MissingCredentialsError` naming the exact env vars needed — **before** any network call.

## Commands

```
tweet         Get, create, or delete Posts (tweets).
search        Search recent/full-archive Posts; counts.
timeline      A user's Posts, mentions, or home timeline.
user          Look up users; me; followers/following.
like          Like/unlike; liking-users; liked-tweets.
retweet       Repost/undo; retweeted-by; quote-tweets.
follow        Follow / unfollow a user.
relationship  Mute/unmute and block/unblock users.
bookmark      List/add/remove bookmarks (OAuth2 only).
list          Manage Lists and their members/tweets.
dm            Send DMs; create a group conversation.
media         Upload media (image one-shot / chunked video).
space         Look up or search Spaces.
account       whoami (user context) + rate-limit probe.
```

Discover subcommands and flags per command:

```bash
node dist/cli.js <command> --help
```

Every command shares the same shape: a sub-action (`args[0]`), then flags, and prints the JSON envelope to stdout. All output is passed through a secret-redactor first, so credentials never leak into logs.

## How to run

```bash
# Direct (no install):
node dist/cli.js tweet get --id 20
node dist/cli.js search recent --query "from:xdevelopers" --max-results 10
node dist/cli.js account whoami          # requires a user token

# Via the linked bin (after `pnpm link --global`):
x tweet create --text "hello from x-api"
```

### Exit codes

| Code | When |
|---|---|
| `0` | Success (or `--help`). |
| `1` | Usage error, missing credentials, or an X API error (`XApiError`). |
| `3` | Rate limited (HTTP 429) — message includes seconds until reset. |

## Tests

```bash
pnpm test            # vitest run — full suite, zero live network (fetch is mocked)
pnpm test:watch      # watch mode
pnpm test:coverage   # coverage report
pnpm typecheck       # tsc --noEmit
```

The suite has **340+ tests** and never touches the network — every client/command test stubs the global `fetch`.

### Opt-in live smoke test

A single live smoke test is **skipped by default**. It runs only when `X_LIVE_SMOKE=1` **and** real credentials are present, making one real call (`GET /2/users/me` under a user token, or `GET /2/users/by/username/xdevelopers` under Bearer):

```bash
X_LIVE_SMOKE=1 X_BEARER_TOKEN=… pnpm test    # runs the otherwise-skipped smoke check
```

Without the flag it is a no-op, so CI never makes a network call.
