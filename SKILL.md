---
name: x-api
description: "Dispatch X API (Twitter API v2) calls via the x-api CLI wrapper — read (tweet/user/search/timeline/space lookups), write (post/like/follow/retweet/mute/block/bookmark/list/DM), and media upload. Use when reading public X data or acting on behalf of a user (posting, engaging, DMing). Requires X_BEARER_TOKEN for reads; OAuth 1.0a (X_API_KEY/SECRET + X_ACCESS_TOKEN/SECRET) or X_OAUTH2_ACCESS_TOKEN for writes."
---

# x-api (Claude Skill)

Dispatch X API (Twitter API v2) calls — reads, user-context writes, and media upload — via the x-api CLI wrapper.

## When to use

Use when you need to:
- Read public X data — look up tweets/users, search recent (or full-archive) Posts, fetch a user's timeline, or look up Spaces.
- Post on behalf of a user — create/delete tweets, and attach media or polls.
- Engage as a user — like, retweet/quote, follow, mute, block.
- Manage bookmarks (**OAuth 2.0 only**) or Lists (create/update/delete, members).
- Send Direct Messages or create a group DM conversation.
- Upload media (image one-shot, or chunked video) and get a `media_id` to attach to a tweet/DM.

## CLI Location

Build once with `pnpm build`, then invoke either way:

```bash
x <command> <subcommand> [flags]              # if linked: pnpm link --global (or npm i -g .)
node <REPO>/dist/cli.js <command> [flags]     # otherwise, an absolute path to the build
```

Examples below use `node dist/cli.js`, i.e. run from the repo root. Substitute `x` or an absolute `<REPO>/dist/cli.js` as appropriate — when this skill is registered for use from arbitrary working directories, pin the absolute path.

## Prerequisites

Credentials come from the X Developer Console → your App → **Keys & Tokens** (<https://console.x.com/>).

**You usually do not need to `export` anything.** On startup the CLI layers env files *underneath* the real environment. First source to set a key wins:

| # | Source | Note |
|---|---|---|
| 1 | exported shell env | always wins; files only fill gaps |
| 2 | `$X_ENV_FILE` | explicit path override (relative resolves against cwd) |
| 3 | `./.env` | **current directory only** — there is no parent-directory walk |
| 4 | `$AFK_HOME/config/afk.env` | machine-wide; `$AFK_HOME` defaults to `~/.afk` |
| 5 | `~/.afk.env` | legacy agent-afk location |

> Because this skill is invoked from arbitrary working directories, put credentials in **`~/.afk/config/afk.env`** — that is the only source that resolves no matter where the CLI is run from. A `./.env` only applies when the cwd happens to be that project. Do not rely on `export`: it dies with the shell.

The vars, by group:

```bash
# ── App-only Bearer — public READS + streams (no user actions) ───────────────────
X_BEARER_TOKEN=...                   # Authorization: Bearer $X_BEARER_TOKEN

# ── OAuth 1.0a user context — WRITES + user reads + media (all four required) ─────
X_API_KEY=...                        # consumer key
X_API_SECRET=...                     # consumer secret
X_ACCESS_TOKEN=...                   # user access token
X_ACCESS_TOKEN_SECRET=...            # user access token secret

# ── OAuth 2.0 user token — WRITES + user reads + media + BOOKMARKS ───────────────
X_OAUTH2_ACCESS_TOKEN=...            # user token from the OAuth 2.0 PKCE flow

# ── Optional — override base URL (default https://api.x.com/2) ───────────────────
# X_API_BASE_URL=https://api.twitter.com/2
```

File syntax: `KEY=value`, optional `export ` prefix, `#` comments (full-line and trailing), single/double/backtick quotes (`\n` expands inside double quotes only). A blank value (`X_BEARER_TOKEN=`) counts as **unset**, so it cannot shadow a real value from a lower-precedence file. Missing or malformed files are skipped silently — a bad line never breaks the run.

> **Tier reality:** the current X API is pay-per-use credits (+ Enterprise); legacy Free/Basic/Pro tiers are being retired. On a free/no-credit account most **reads and many writes fail** with `403 client-forbidden` / `usage-capped` — reads generally need paid access/credits. `GET /2/users/me` (`account whoami`) is the safest "does my auth work" probe. `X_BEARER_TOKEN` (app identity) and `X_OAUTH2_ACCESS_TOKEN` (user identity) share the `Bearer` header shape but are **different identities** — never swap them.

## Auth mode selection

- **Reads** → prefer **Bearer** (`X_BEARER_TOKEN`); fall back to any user token if no Bearer.
- **Writes** → **OAuth 1.0a** (all four vars) or **OAuth 2.0** user token; app-only Bearer is rejected. Both present → OAuth 1.0a preferred.
- **User-context reads** (`users/me`, home timeline, liking-users, liked-tweets, `account whoami`) → a **user token** (OAuth1/OAuth2); Bearer rejected.
- **Bookmarks** → **OAuth 2.0 only**.
- **Full-archive search & counts** (`search all`, `search counts`) → **app-only Bearer only**.
- Force a mode with `--auth bearer|oauth1|oauth2` (errors if that mode's creds are absent).

## Subcommands

### tweet ★

Get, create, or delete Posts. **Primary command.**

```bash
node dist/cli.js \
  tweet create \
  --text "hello from x-api" \
  --reply-settings following
```
```json
{ "data": { "id": "1720000000000000000", "text": "hello from x-api" } }
```

Options (for `create`):
- `--text <s>` — Post body (**required** unless media/poll/quote is given)
- `--reply-to <tweetId>` — reply to a Post (`reply.in_reply_to_tweet_id`)
- `--quote <tweetId>` — quote-tweet (`quote_tweet_id`)
- `--media-ids <csv>` — attach uploaded media (`media.media_ids[]`)
- `--poll-options <csv>` + `--poll-duration <min>` — create a poll
- `--reply-settings <following|mentionedUsers|subscribers|verified>` — who can reply

Require **≥1** of text / media / poll / quote; media, poll, and quote are mutually exclusive. Also: `tweet get --id <id>` (or `--ids <csv>`) → read; `tweet delete --id <id>` → write.

Output: `data.id` + `data.text` (create returns HTTP 201). *(get = read/Bearer OK; create & delete = write, user context.)*

### search

Search recent or full-archive Posts, or get Post counts.

```bash
node dist/cli.js \
  search recent --query "from:xdevelopers -is:retweet" --max-results 10
```
```json
{ "data": [ { "id": "1307025659294674945", "text": "Here's an article ..." } ],
  "meta": { "result_count": 10, "next_token": "7140dibd..." } }
```

`recent` = read (Bearer OK); `all` (full-archive) and `counts` = **app-only Bearer only** (Pro/Enterprise). Supports `--all` / `--max-pages <n>` cursor pagination.

### timeline

A user's Posts, mentions, or home timeline.

```bash
node dist/cli.js \
  timeline posts --id 2244994945 --max-results 5 --exclude replies,retweets
```
```json
{ "data": [ { "id": "1720…", "text": "…" } ], "meta": { "result_count": 5 } }
```

`posts` / `mentions` = read (Bearer OK). `home` (reverse-chronological) = **user context only** (`--id` must be the authenticated user).

### user

Look up users, `me`, or followers/following.

```bash
node dist/cli.js \
  user get --username xdevelopers --user-fields description,public_metrics
```
```json
{ "data": { "id": "2244994945", "name": "Developers", "username": "XDevelopers" } }
```

`get` (`--id | --ids | --username | --usernames`, exactly one) / `followers` / `following` = read (Bearer OK). `me` = **user context only**.

### like

Like/unlike a Post; list liking-users or a user's liked-tweets.

```bash
node dist/cli.js \
  like create --user-id 2244994945 --tweet-id 20
```
```json
{ "data": { "liked": true } }
```

`create` / `delete` (`--user-id`, `--tweet-id`) = write. `liking-users` (`--id` tweet) / `liked-tweets` (`--id` user) = **user context only**.

### retweet

Repost/undo; list retweeted-by or quote-tweets.

```bash
node dist/cli.js \
  retweet create --user-id 2244994945 --tweet-id 20
```
```json
{ "data": { "retweeted": true } }
```

`create` / `delete` (`--user-id`, `--tweet-id`) = write. `retweeted-by` / `quote-tweets` (`--id` tweet) = read (Bearer OK).

### follow

Follow / unfollow a user *(write — user context)*.

```bash
node dist/cli.js \
  follow follow --user-id 2244994945 --target 783214
```
```json
{ "data": { "following": true, "pending_follow": false } }
```

`follow` and `unfollow` both take `--user-id` (source/authenticated) + `--target` (user to (un)follow).

### relationship

Mute/unmute and block/unblock users *(write — user context)*.

```bash
node dist/cli.js \
  relationship mute --user-id 2244994945 --target 783214
```
```json
{ "data": { "muting": true } }
```

Sub-actions `mute` / `unmute` / `block` / `unblock`, all with `--user-id` + `--target`. ⚠️ block/unblock availability is in flux (possibly Enterprise-only on some tiers) — a `403 client-forbidden` here likely means your tier lacks block access.

### bookmark

List/add/remove bookmarks *(**OAuth 2.0 only**)*.

```bash
node dist/cli.js \
  bookmark list --id 2244994945 --all
```
```json
{ "data": [ { "id": "20", "text": "just setting up my twttr" } ],
  "meta": { "result_count": 1 } }
```

`list` (`--id` user) / `add` / `remove` (`--user-id`, `--tweet-id`). Requires `X_OAUTH2_ACCESS_TOKEN` — no Bearer, no OAuth 1.0a alternative.

### list

Manage Lists and their members/tweets.

```bash
node dist/cli.js \
  list create --name "AI builders" --description "people shipping AI" --private
```
```json
{ "data": { "id": "1700000000000000000", "name": "AI builders" } }
```

Read (Bearer OK): `get` / `tweets` / `owned` / `members-list`. Write: `create` / `update` / `delete` / `members-add` / `members-remove`.

### dm

Send DMs; create a group conversation *(all writes — user context)*.

```bash
node dist/cli.js \
  dm send --participant 783214 --text "hey there"
```
```json
{ "data": { "dm_conversation_id": "783214-2244994945", "dm_event_id": "1720…" } }
```

`send` needs exactly one of `--participant <userId>` / `--conversation <dmConversationId>` (+ `--text`, optional `--media-id`). `create-conversation` needs `--participants <csv>` + `--text`.

### media

Upload media — image one-shot or chunked video *(write — `media.write` / OAuth 1.0a)*. Returns a `media_id` to attach via `tweet create --media-ids` or `dm send --media-id`.

```bash
node dist/cli.js \
  media upload --file ./photo.png --category tweet_image
```
```json
{ "id": "1146654567674912769", "media_key": "3_1146654567674912769" }
```

Small images/subtitles → one-shot `POST /2/media/upload` (real `multipart/form-data`). Video / large files / `--chunked` → INIT → APPEND(*) → FINALIZE → poll STATUS (`--media-type`, `--chunk-size`, `--max-polls`). Uploads use real multipart form-data (not base64) so they work against the live API.

### space

Look up or search Spaces *(read — Bearer OK)*.

```bash
node dist/cli.js \
  space search --query "ai" --state live --max-results 10
```
```json
{ "data": [ { "id": "1YpKkZEWlBaxj", "state": "live", "title": "AI talk" } ] }
```

`get` (`--id | --ids`, exactly one) or `search` (`--query`, optional `--state`, `--max-results`). Space search is **not** cursor-paginated.

### account

`whoami` (user context) + a `rate-limit` probe.

```bash
node dist/cli.js account whoami
```
```json
{ "data": { "id": "2244994945", "name": "Developers", "username": "XDevelopers" } }
```

`whoami` (default sub-action) = **user context only** (`GET /2/users/me`). `rate-limit` makes a cheap read and prints the captured `x-rate-limit-*` headers (add `--username <handle>` to probe under Bearer).

## Error handling

The CLI prints a redacted message to stderr and sets an exit code:
- `400` → **fix the request** (malformed params; problem type `invalid-request`). Exit 1.
- `401` → **bad/expired auth** or a broken OAuth 1.0a signature. Exit 1.
- `403` → **wrong auth mode** (`unsupported-authentication` — e.g. Bearer on a user-context route) **or insufficient tier** (`client-forbidden` / `usage-capped`). Exit 1.
- `404` → **not found** (`resource-not-found`; also appears as a partial error on 200). Exit 1.
- `429` → **rate limited** — message says "rate limited, retry in Ns" (back off until `x-rate-limit-reset`). **Exit 3.**
- **Partial `errors[]` on HTTP 200** → some items failed (deleted/suspended/not-authorized) while others succeeded — the envelope is printed intact; **inspect per item**.
- **Missing credentials** → exits **1** with a `MissingCredentialsError` naming the exact env vars, before any network call. If you believe the creds *are* set, the env file was not found or was outranked — run `X_ENV_DEBUG=1 <CLI_PATH> --help` to see which file supplied which var (**key names only, never values** — safe to surface in output).

`usage-capped` means a credit/quota cap was hit (`period` Daily/Monthly, `scope` Account/Product) — **stop, don't hammer**.

## Rate limits

- Windowed — most limits reset every **15 minutes**.
- Two independent pools: **per-app** (Bearer) and **per-user** (OAuth1/OAuth2) — they don't deplete each other.
- The CLI captures `x-rate-limit-limit` / `-remaining` / `-reset` on every response; `account rate-limit` prints them so you can see remaining quota.

## Running tests

```bash
pnpm test   # from the repo root
# 370+ tests, all mocked — ZERO live network.
# The single live smoke test is skipped unless X_LIVE_SMOKE=1 (and real creds) are set.
```
