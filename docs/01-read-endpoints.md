# X API v2 — Read (GET) Endpoints Reference

Implementation reference for building a CLI against the current **X API v2** (formerly
Twitter API). Focus: exact paths, required vs optional params, param names, auth type,
and access tier per endpoint.

- **Base URL (host):** `https://api.x.com` (the legacy `https://api.twitter.com` host still resolves; prefer `api.x.com`)
- **All v2 read endpoints are HTTPS GET.** Path IDs use `{id}` placeholders below.
- **Spec basis:** OpenAPI `2.166` embedded in the official docs (`docs.x.com`), fetched 2026-07-20. See "Sources" at the bottom.

> ⚠️ **Time-sensitive.** X changed pricing/tiers repeatedly (v2 pay-per-use launched
> Feb 2026; "Owned Reads" pricing Apr 2026). Field enums, `max_results` caps, and
> tier gating drift between spec revisions. **Re-validate against the Developer Console
> and live docs before shipping.**

---

## 0. READ THIS FIRST — Auth & Access Tiers

### 0.1 Free tier is (largely) write-only for these endpoints

The **Free** tier is intended for development/testing and is **heavily restricted** — it is
effectively **write-only + a tiny amount of self-owned reads**. Public read endpoints such as
`GET /2/tweets`, `GET /2/tweets/search/recent`, and `GET /2/users/:id` generally are **not**
usable on Free (attempting them typically returns HTTP 403 error `453` "You currently have
access to a subset of endpoints"). **For production reads, Basic ($200/mo) is the practical
minimum; Pro ($5,000/mo) unlocks full-archive search and higher volume; full-archive search
also historically required an Academic Research project.** Enterprise offers custom access.

> **CLI implication:** treat every GET read endpoint below as requiring **Basic tier or
> higher** unless you have confirmed the caller's project has read access. Do not assume Free
> works. `coverage_gaps` (bottom) explains why exact per-tier endpoint availability is not
> machine-verifiable from the OpenAPI spec.

### 0.2 Authentication types

| Auth type | Header | Who it acts as | Use when |
| :--- | :--- | :--- | :--- |
| **App-only** (OAuth 2.0 Bearer Token) | `Authorization: Bearer <TOKEN>` | The app (no user) | Reading **public** data server-to-server |
| **User context** (OAuth 2.0 Authorization Code + PKCE) | `Authorization: Bearer <USER_TOKEN>` | A specific user (scoped) | Private/owned data, or endpoints that require a user |
| **User context** (OAuth 1.0a) | `Authorization: OAuth ...` (signed) | A specific user | Legacy user-context; still accepted on many reads |

Each endpoint's OpenAPI `security` block lists which of the three it accepts. In the tables
below the **Auth** column reports this:

- **App-only OK** = Bearer works (and OAuth2 user / OAuth1.0a also work).
- **User-context only** = Bearer is **rejected**; you must use OAuth 2.0 user token (or, where
  offered, OAuth 1.0a). The endpoint reads private/owned data or is scoped to the caller.

**OAuth 2.0 user-context scopes** referenced below: `tweet.read`, `users.read`,
`follows.read`, `like.read`, `space.read`, `list.read`, `bookmark.read`,
`offline.access` (for refresh tokens). Request the scopes an endpoint needs.

Cross-check of App-only vs User-context is corroborated by the rate-limit table's **Per App**
column: a populated "Per App" limit ⇒ App-only Bearer is allowed; a "—" ⇒ user-context only.

### 0.3 Fields & expansions (applies to almost every read endpoint)

v2 returns **minimal** data by default. A Post returns only `id`, `text`,
`edit_history_tweet_ids`; a User returns only `id`, `name`, `username`.

- Request more with **`*.fields`** params (comma-separated, `explode=false`):
  `tweet.fields`, `user.fields`, `media.fields`, `poll.fields`, `place.fields`,
  `space.fields`, `list.fields`, `topic.fields`, `search_count.fields`.
- Request related objects with **`expansions`** (comma-separated). Expanded objects land in a
  top-level **`includes`** object (`includes.users`, `includes.tweets`, `includes.media`,
  `includes.polls`, `includes.places`, `includes.topics`). Match them back by ID.
- You cannot request sub-fields (e.g. `public_metrics.like_count`) — you get the whole object.

**Tweet `expansions` enum (14):** `article.cover_media`, `article.media_entities`,
`attachments.media_keys`, `attachments.media_source_tweet`, `attachments.poll_ids`,
`author_id`, `edit_history_tweet_ids`, `entities.mentions.username`, `geo.place_id`,
`in_reply_to_user_id`, `entities.note.mentions.username`, `referenced_tweets.id`,
`referenced_tweets.id.attachments.media_keys`, `referenced_tweets.id.author_id`.

**User `expansions` enum (3):** `affiliation.user_id`, `most_recent_tweet_id`,
`pinned_tweet_id`.

**Tweet `tweet.fields` enum:** `article, attachments, author_id, card_uri, community_id,
context_annotations, conversation_id, created_at, display_text_range, edit_controls,
edit_history_tweet_ids, entities, geo, id, in_reply_to_user_id, lang, media_metadata,
non_public_metrics, note_tweet, organic_metrics, possibly_sensitive, promoted_metrics,
public_metrics, referenced_tweets, reply_settings, scopes, source, text, withheld`
(plus newer Community-Notes-related fields such as `matched_media_notes`,
`note_request_suggestions`, `paid_partnership`).

**User `user.fields` enum:** `affiliation, confirmed_email, connection_status, created_at,
description, entities, id, is_identity_verified, location, most_recent_tweet_id, name,
parody, pinned_tweet_id, profile_banner_url, profile_image_url, protected, public_metrics,
receives_your_dm, subscription, subscription_type, url, username, verified,
verified_followers_count, verified_type, withheld`.

### 0.4 Pagination (CLI must handle two token styles)

- **Search & counts endpoints** (`/2/tweets/search/*`, `/2/tweets/counts/*`) accept **both**
  `next_token` **and** `pagination_token` as the *request* param (interchangeable).
- **All other paginated endpoints** accept **only `pagination_token`** as the *request* param.
- **Every** paginated response returns the cursor in **`meta.next_token`** (and often
  `meta.previous_token`). **Your paginator: read `meta.next_token`, then send it back as
  `pagination_token`** (works everywhere; also valid as `next_token` on search/counts).
- Loop until no `next_token` is returned.
- Token encodings differ (mostly cosmetic — treat as opaque strings): followers/following use
  a base32 token (min length 16); most others use a base36 token.

### 0.5 Common response envelope

```json
{
  "data":     { /* object OR array of objects */ },
  "includes": { "users": [], "tweets": [], "media": [], "polls": [], "places": [], "topics": [] },
  "meta":     { "result_count": 10, "next_token": "...", "previous_token": "...",
                "newest_id": "...", "oldest_id": "..." },
  "errors":   [ { "title": "...", "type": "...", "detail": "...", "status": 123 } ]
}
```

- **Lookup (non-paginated) endpoints return NO `meta`.**
- Partial success is normal: HTTP 200 can still carry an `errors[]` array (e.g. one unknown ID
  among many) alongside `data`. Always inspect `errors`.

### 0.6 Rate limits (per 15 min unless noted) & 429s

Populated **Per App** = App-only Bearer allowed. `—` = user-context only. On 429, read
`x-rate-limit-limit` / `x-rate-limit-remaining` / `x-rate-limit-reset` (unix secs) and back off
until reset. Rate limits are **separate** from usage billing.

---

## 1. Posts (Tweets) lookup

### `GET /2/tweets` — look up multiple Posts by IDs
- **Purpose:** batch-fetch up to 100 Posts.
- **Required:** `ids` (query) — comma-separated Post IDs, **1–100**, each `^[0-9]{1,19}$`.
- **Optional:** `tweet.fields`, `expansions` (14), `media.fields`, `poll.fields`,
  `user.fields`, `place.fields`.
- **Pagination:** none. **`meta`:** none.
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **3,500/15min app, 5,000/15min user.**

```bash
curl "https://api.x.com/2/tweets?ids=1346889436626259968,20&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,verified" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "1346889436626259968", "author_id": "2244994945",
    "created_at": "2021-01-06T18:40:40.000Z", "text": "Learn how to use..." } ],
  "includes": { "users": [ { "id": "2244994945", "username": "XDevelopers", "name": "X Dev" } ] } }
```

### `GET /2/tweets/{id}` — look up a single Post
- **Purpose:** fetch one Post by ID.
- **Required:** `id` (path) — `^[0-9]{1,19}$`.
- **Optional:** same `*.fields` + `expansions` (14) as `GET /2/tweets`.
- **Pagination:** none. **`meta`:** none.
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **450/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/tweets/1346889436626259968?tweet.fields=created_at,public_metrics" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": { "id": "1346889436626259968", "text": "Learn how to use...",
  "created_at": "2021-01-06T18:40:40.000Z",
  "public_metrics": { "retweet_count": 5, "reply_count": 1, "like_count": 30,
                      "quote_count": 0, "bookmark_count": 2, "impression_count": 1234 } } }
```

---

## 2. Search Posts

Both search endpoints share query operators. **Basics of query operators:**
- Keyword: `python`; exact phrase: `"machine learning"`; hashtag `#AI`; cashtag `$TWTR`;
  mention `@XDevelopers`.
- User: `from:elonmusk`, `to:XDevelopers`, `retweets_of:X`.
- Content: `has:images`, `has:videos`, `has:links`, `has:media`, `has:mentions`,
  `url:github.com`.
- Filter: `lang:en`, `-is:retweet`, `-is:reply`, `is:verified` (leading `-` negates).
- Combine with boolean logic + grouping:
  `(AI OR "artificial intelligence") lang:en -is:retweet has:links`.

### `GET /2/tweets/search/recent` — search last 7 days
- **Purpose:** search Posts from the previous ~7 days.
- **Required:** `query` (string, **1–512** chars on standard access; 1,024 for Enterprise —
  spec-level max is 4096).
- **Key optional:** `max_results` (**default 10, min 10, max 100**), `start_time`/`end_time`
  (RFC 3339 `YYYY-MM-DDTHH:mm:ssZ`), `since_id`/`until_id` (Post ID), `sort_order`
  (`recency` | `relevancy`), `next_token`/`pagination_token`; all `*.fields` + `expansions`.
- **`meta`:** `newest_id`, `oldest_id`, `result_count`, `next_token`.
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **450/15min app, 300/15min user.** Consumes monthly Post cap.

```bash
curl "https://api.x.com/2/tweets/search/recent?query=python%20lang%3Aen%20-is%3Aretweet&max_results=100&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=username" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "15...", "text": "...", "author_id": "..." } ],
  "includes": { "users": [ { "id": "...", "username": "..." } ] },
  "meta": { "newest_id": "...", "oldest_id": "...", "result_count": 100, "next_token": "b26v..." } }
```

### `GET /2/tweets/search/all` — full-archive search (Pro / Academic / Enterprise)
- **Purpose:** search the complete public archive back to **March 2006**.
- **Access:** **NOT on Basic.** Pay-per-use/**Pro** or Enterprise; historically required an
  **Academic Research** project. **App-only Bearer ONLY** per the OpenAPI security block.
- **Required:** `query` (**1–1,024** chars standard; 4,096 Enterprise).
- **Key optional:** `max_results` (**default 10, min 10, max 500**), `start_time`/`end_time`,
  `since_id`/`until_id`, `sort_order`, `next_token`/`pagination_token`; all `*.fields` +
  `expansions`.
- **`meta`:** `newest_id`, `oldest_id`, `result_count`, `next_token`.
- **Auth:** **App-only Bearer only** (OAuth2 user / OAuth1.0a **not** offered here).
- **Rate limit:** **300/15min app + 1/sec.** Consumes monthly Post cap.

```bash
curl "https://api.x.com/2/tweets/search/all?query=%28from%3ATwitterDev%20OR%20from%3ATwitterAPI%29%20has%3Amedia%20-is%3Aretweet&start_time=2020-01-01T00:00:00Z&max_results=500" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "...", "text": "..." } ],
  "meta": { "newest_id": "...", "oldest_id": "...", "result_count": 500, "next_token": "1jal..." } }
```

---

## 3. Counts

Counts return **volume over time** (no Post content). Only `search_count.fields` applies
(`start`, `end`, `tweet_count`). No `expansions`, no `max_results`.

### `GET /2/tweets/counts/recent` — recent (7-day) Post counts
- **Required:** `query` (1–512 standard).
- **Key optional:** `granularity` (`minute` | `hour` | `day`, **default `hour`**),
  `start_time`/`end_time`, `since_id`/`until_id`, `next_token`/`pagination_token`,
  `search_count.fields`.
- **`meta`:** `newest_id`, `oldest_id`, `next_token`, **`total_tweet_count`**.
- **Auth:** **App-only Bearer only.**
- **Tier / rate limit:** Basic+; **300/15min app** (no user-context limit).

```bash
curl "https://api.x.com/2/tweets/counts/recent?query=python&granularity=day" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "start": "2026-07-13T00:00:00.000Z", "end": "2026-07-14T00:00:00.000Z",
              "tweet_count": 4213 } ],
  "meta": { "total_tweet_count": 30122 } }
```

### `GET /2/tweets/counts/all` — full-archive Post counts (Pro / Enterprise)
- **Access:** same gating as `search/all` (not Basic).
- **Required:** `query` (1–1,024 standard).
- **Key optional / `meta` / fields:** identical to `counts/recent` (`granularity` default
  `hour`; `meta.total_tweet_count`).
- **Auth:** **App-only Bearer only.**
- **Rate limit:** **300/15min app.**

```bash
curl "https://api.x.com/2/tweets/counts/all?query=python&granularity=day&start_time=2020-01-01T00:00:00Z" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

---

## 4. Timelines

All three take a **`{id}`** path param (User ID) and accept only **`pagination_token`** as the
request cursor. They return `meta` with `newest_id`, `oldest_id`, `result_count`,
`next_token`, `previous_token`. All `*.fields` + Tweet `expansions` (14) apply.

### `GET /2/users/{id}/tweets` — a user's Posts
- **Required:** `id` (path).
- **Key optional:** `max_results` (**min 5, max 100**; server default ~10, **not declared in
  spec — set explicitly**), `exclude` (array: `replies`, `retweets`), `start_time`/`end_time`,
  `since_id`/`until_id`, `pagination_token`.
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **10,000/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/users/2244994945/tweets?max_results=100&exclude=retweets,replies&tweet.fields=created_at" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "...", "text": "...", "edit_history_tweet_ids": ["..."] } ],
  "meta": { "result_count": 100, "newest_id": "...", "oldest_id": "...", "next_token": "7140..." } }
```

### `GET /2/users/{id}/mentions` — Posts mentioning a user
- **Required:** `id` (path).
- **Key optional:** `max_results` (**min 5, max 100**; no spec default), `start_time`/
  `end_time`, `since_id`/`until_id`, `pagination_token`. (No `exclude`.)
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **450/15min app, 300/15min user.**

```bash
curl "https://api.x.com/2/users/2244994945/mentions?max_results=100" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/users/{id}/timelines/reverse_chronological` — home timeline
- **Purpose:** the authenticated user's reverse-chronological home timeline.
- **Required:** `id` (path) — **must equal the authenticated user** (`UserIdMatchesAuthenticatedUser`).
- **Key optional:** `max_results` (**min 1, max 100**; no spec default), `exclude`
  (`replies`, `retweets`), `start_time`/`end_time`, `since_id`/`until_id`, `pagination_token`.
- **Auth:** **User-context only** (OAuth2 `tweet.read`+`users.read`, or OAuth1.0a). **No
  App-only Bearer.**
- **Tier / rate limit:** Basic+; **180/15min user** (no app limit).

```bash
curl "https://api.x.com/2/users/2244994945/timelines/reverse_chronological?max_results=100" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```

---

## 5. Users lookup

All accept `user.fields` + User `expansions` (3) + `tweet.fields` (for the expanded pinned
tweet). Lookup variants (ids / by / by-username / :id / me) are **not paginated and return no
`meta`.**

### `GET /2/users` — look up multiple users by IDs
- **Required:** `ids` (query) — comma-separated User IDs, **1–100**, each `^[0-9]{1,19}$`.
- **Auth:** App-only OK (Bearer | OAuth2 | OAuth1.0a). **Tier/RL:** Basic+; **300/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/users?ids=2244994945,6253282&user.fields=created_at,public_metrics,verified" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "2244994945", "name": "X Dev", "username": "TwitterDev",
              "verified": false } ] }
```

### `GET /2/users/{id}` — look up one user by ID
- **Required:** `id` (path). **Auth:** App-only OK. **Tier/RL:** Basic+; **300/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/users/2244994945?user.fields=description,public_metrics" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/users/by` — look up multiple users by usernames
- **Required:** `usernames` (query) — comma-separated handles, **1–100**, each `^[A-Za-z0-9_]{1,15}$`.
- **Auth:** App-only OK. **Tier/RL:** Basic+; **300/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/users/by?usernames=TwitterDev,XDevelopers&user.fields=verified_type" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/users/by/username/{username}` — look up one user by username
- **Required:** `username` (path) — `^[A-Za-z0-9_]{1,15}$`.
- **Auth:** App-only OK. **Tier/RL:** Basic+; **300/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/users/by/username/TwitterDev?user.fields=created_at" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/users/me` — the authenticated user
- **Required:** none.
- **Auth:** **User-context only** (OAuth2 `tweet.read`+`users.read`, or OAuth1.0a). **No
  App-only Bearer** (there is no user without a user token).
- **Tier / rate limit:** Basic+; **75/15min user** (no app limit).

```bash
curl "https://api.x.com/2/users/me?user.fields=username,public_metrics" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```

---

## 6. Follows & relationships

Both paginated; **`pagination_token`** cursor; `meta` = `next_token`, `previous_token`,
`result_count`. Return **User** objects (User `expansions`, `user.fields`, `tweet.fields`).

> **NOTE:** X removed the Follows lookup endpoints from **Basic and Pro** self-serve tiers in
> a prior change (see changelog). Availability is account/tier-dependent — verify access
> before relying on these. They still exist in the API surface and for Enterprise.

### `GET /2/users/{id}/followers` — accounts following a user
- **Required:** `id` (path).
- **Key optional:** `max_results` (**min 1, max 1000**; no spec default), `pagination_token`
  (base32, min length 16).
- **Auth:** App-only OK (Bearer | OAuth2 `follows.read`+`tweet.read`+`users.read` | OAuth1.0a).
- **Rate limit:** **300/15min app, 300/15min user** (subject to tier availability above).

```bash
curl "https://api.x.com/2/users/2244994945/followers?max_results=1000&user.fields=username" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "...", "name": "...", "username": "..." } ],
  "meta": { "result_count": 1000, "next_token": "DFED...", "previous_token": "..." } }
```

### `GET /2/users/{id}/following` — accounts a user follows
- **Required:** `id` (path).
- **Key optional:** `max_results` (**min 1, max 1000**; no spec default), `pagination_token`
  (base32, min length 16).
- **Auth:** App-only OK (Bearer | OAuth2 `follows.read`+`tweet.read`+`users.read` | OAuth1.0a).
- **Rate limit:** **300/15min app, 300/15min user** (subject to tier availability above).

```bash
curl "https://api.x.com/2/users/2244994945/following?max_results=1000" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

---

## 7. Engagement reads

### `GET /2/tweets/{id}/liking_users` — users who liked a Post
- **Required:** `id` (path, Post ID). Returns **User** objects.
- **Key optional:** `max_results` (**default 100, min 1, max 100**), `pagination_token`;
  User `expansions`, `user.fields`, `tweet.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** **User-context only** (OAuth2 `like.read`+`tweet.read`+`users.read`, or OAuth1.0a).
  **No App-only Bearer.**
- **Tier / rate limit:** Basic+; **75/15min app, 75/15min user** (rate table lists an app
  limit, but the security block omits Bearer — use user context).

```bash
curl "https://api.x.com/2/tweets/1346889436626259968/liking_users?max_results=100&user.fields=username" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```
```json
{ "data": [ { "id": "...", "name": "...", "username": "..." } ],
  "meta": { "result_count": 100, "next_token": "..." } }
```

### `GET /2/users/{id}/liked_tweets` — Posts a user has liked
- **Required:** `id` (path, User ID). Returns **Tweet** objects.
- **Key optional:** `max_results` (**min 5, max 100**; no spec default), `pagination_token`;
  Tweet `expansions` (14) + `tweet.fields`/`media.fields`/`poll.fields`/`user.fields`/`place.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** **User-context only** (OAuth2 `like.read`+`tweet.read`+`users.read`, or OAuth1.0a).
  **No App-only Bearer.**
- **Tier / rate limit:** Basic+; **75/15min app, 75/15min user.**

```bash
curl "https://api.x.com/2/users/2244994945/liked_tweets?max_results=100&tweet.fields=created_at" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```

### `GET /2/tweets/{id}/retweeted_by` — users who reposted a Post
- **Required:** `id` (path, Post ID). Returns **User** objects.
- **Key optional:** `max_results` (**default 100, min 1, max 100**), `pagination_token`;
  User `expansions`, `user.fields`, `tweet.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **75/15min app, 75/15min user.**

```bash
curl "https://api.x.com/2/tweets/1346889436626259968/retweeted_by?max_results=100" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/tweets/{id}/quote_tweets` — Posts quoting a Post
- **Required:** `id` (path, Post ID). Returns **Tweet** objects.
- **Key optional:** `max_results` (**default 10, min 10, max 100**), `exclude` (array:
  `replies`, `retweets`), `pagination_token`; Tweet `expansions` (14) + all `*.fields`.
- **`meta`:** `next_token`, `result_count` (**no `previous_token`**).
- **Auth:** App-only OK (Bearer | OAuth2 `tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **75/15min app, 75/15min user.**

```bash
curl "https://api.x.com/2/tweets/1346889436626259968/quote_tweets?max_results=100&tweet.fields=created_at" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "...", "text": "...", "referenced_tweets": [ { "type": "quoted", "id": "1346889436626259968" } ] } ],
  "meta": { "result_count": 100, "next_token": "..." } }
```

---

## 8. Bookmarks (read)

### `GET /2/users/{id}/bookmarks` — the authenticated user's bookmarks
- **Required:** `id` (path) — **must equal the authenticated user**
  (`UserIdMatchesAuthenticatedUser`). Returns **Tweet** objects.
- **Key optional:** `max_results` (**min 1, max 100**; no spec default), `pagination_token`;
  Tweet `expansions` (14) + all `*.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** **OAuth 2.0 user-context ONLY**, scopes `bookmark.read`+`tweet.read`+`users.read`.
  **No App-only Bearer AND no OAuth 1.0a** — this is the strictest read endpoint.
- **Tier / rate limit:** Basic+; **180/15min user** (no app limit).

```bash
curl "https://api.x.com/2/users/2244994945/bookmarks?max_results=100&tweet.fields=created_at" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```
```json
{ "data": [ { "id": "...", "text": "...", "edit_history_tweet_ids": ["..."] } ],
  "meta": { "result_count": 100, "next_token": "..." } }
```

---

## 9. Lists (read)

### `GET /2/lists/{id}` — look up one List
- **Required:** `id` (path, List ID `^[0-9]{1,19}$`). Returns a single **List**; **no `meta`.**
- **Optional:** `list.fields` (`created_at, description, follower_count, id, member_count,
  name, owner_id, private`), `expansions` = `owner_id` (only), `user.fields`.
- **Auth:** App-only OK (Bearer | OAuth2 `list.read`+`tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **75/15min app, 75/15min user.**

```bash
curl "https://api.x.com/2/lists/84839422?list.fields=member_count,follower_count,private&expansions=owner_id&user.fields=username" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": { "id": "84839422", "name": "Official Twitter Accounts",
            "owner_id": "783214", "member_count": 25, "follower_count": 1200, "private": false },
  "includes": { "users": [ { "id": "783214", "username": "Twitter" } ] } }
```

### `GET /2/users/{id}/owned_lists` — Lists a user owns
- **Required:** `id` (path, User ID). Returns **List** objects.
- **Key optional:** `max_results` (**default 100, min 1, max 100**), `pagination_token`;
  `list.fields`, `expansions`=`owner_id`, `user.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** App-only OK (Bearer | OAuth2 `list.read`+`tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **15/15min app, 15/15min user.**

```bash
curl "https://api.x.com/2/users/2244994945/owned_lists?max_results=100&list.fields=member_count" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/lists/{id}/members` — members of a List
- **Required:** `id` (path, List ID). Returns **User** objects.
- **Key optional:** `max_results` (**default 100, min 1, max 100**), `pagination_token`;
  User `expansions` (3), `user.fields`, `tweet.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** App-only OK (Bearer | OAuth2 `list.read`+`tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **900/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/lists/84839422/members?max_results=100&user.fields=username" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/lists/{id}/tweets` — Posts in a List's timeline
- **Required:** `id` (path, List ID). Returns **Tweet** objects.
- **Key optional:** `max_results` (**default 100, min 1, max 100**), `pagination_token`
  (base36); Tweet `expansions` (14) + all `*.fields`.
- **`meta`:** `next_token`, `previous_token`, `result_count`.
- **Auth:** App-only OK (Bearer | OAuth2 `list.read`+`tweet.read`+`users.read` | OAuth1.0a).
- **Tier / rate limit:** Basic+; **900/15min app, 900/15min user.**

```bash
curl "https://api.x.com/2/lists/84839422/tweets?max_results=100&tweet.fields=created_at" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "...", "text": "...", "edit_history_tweet_ids": ["..."] } ],
  "meta": { "result_count": 100, "next_token": "..." } }
```

---

## 10. Spaces (read)

Space ID pattern: `^[a-zA-Z0-9]{1,13}$`.
**`space.fields` enum (18):** `created_at, creator_id, ended_at, host_ids, id,
invited_user_ids, is_ticketed, lang, participant_count, scheduled_start, speaker_ids,
started_at, state, subscriber_count, title, topic_ids, updated_at`.
**Space `expansions` (5):** `creator_id`, `host_ids`, `invited_user_ids`, `speaker_ids`,
`topic_ids`. **`topic.fields`:** `description, id, name`. Space object `state`:
`live | scheduled | ended`.
**Auth for all Spaces reads:** App-only OK — **Bearer | OAuth2 `space.read`+`tweet.read`+
`users.read`**. (Spaces reads do **not** offer OAuth 1.0a.) `user.fields` also applies via
`creator_id`/`host_ids`/etc. expansions.

### `GET /2/spaces` — look up multiple Spaces by IDs
- **Required:** `ids` (query) — comma-separated Space IDs, **1–100**. **No pagination / no `meta`.**
- **Optional:** `space.fields`, `expansions` (5), `user.fields`, `topic.fields`.
- **Tier / rate limit:** Basic+; **300/15min app, 300/15min user.**

```bash
curl "https://api.x.com/2/spaces?ids=1DXxyRYNejbKM&space.fields=title,state,host_ids,participant_count&expansions=host_ids&user.fields=username" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "1DXxyRYNejbKM", "state": "live", "title": "Spaces are Awesome",
              "host_ids": ["2244994945"], "participant_count": 10 } ] }
```

### `GET /2/spaces/{id}` — look up one Space
- **Required:** `id` (path, Space ID). Returns a single **Space**; **no `meta`.**
- **Optional:** `space.fields`, `expansions` (5), `user.fields`, `topic.fields`.
- **Tier / rate limit:** Basic+; **300/15min app, 300/15min user.**

```bash
curl "https://api.x.com/2/spaces/1DXxyRYNejbKM?space.fields=title,state,started_at" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

### `GET /2/spaces/search` — search Spaces (brief)
- **Purpose:** find live/scheduled Spaces by keyword.
- **Required:** `query` (string, 1–2,048 chars).
- **Key optional:** `state` (enum **`live` | `scheduled` | `all`**, **default `all`** — note:
  this query param differs from the Space object's `state` which is `live|scheduled|ended`),
  `max_results` (**default 100, min 1, max 100**); `space.fields`, `expansions` (5),
  `user.fields`, `topic.fields`.
- **`meta`:** **`result_count` only — NOT cursor-paginated** (no `next_token`).
- **Tier / rate limit:** Basic+; **300/15min app, 300/15min user.**

```bash
curl "https://api.x.com/2/spaces/search?query=crypto&state=live&max_results=100&space.fields=title,state" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```
```json
{ "data": [ { "id": "1DXxyRYNejbKM", "state": "live", "title": "..." } ],
  "meta": { "result_count": 42 } }
```

---

## Deprecation / status notes

- **v1.1** is legacy (no new features; some media-upload + specialized endpoints remain). All
  read work here is **v2**. Nothing in the v2 read set above is marked deprecated in the
  current docs, **except** the Post `source` field, which is documented as deprecated.
- **Follows lookup** (`/followers`, `/following`) was removed from Basic/Pro self-serve tiers
  in a prior changelog entry — availability is account/tier-dependent (§6 note).
- **`retweets_of_me`** exists (`GET /2/users/reposts_of_me`, user-context, 75/15min) but was
  outside the requested groups; noted for completeness.

## Sources (official; fetched 2026-07-20)

- `https://docs.x.com/x-api/fundamentals/rate-limits` (`.md`) — per-endpoint app/user limits.
- `https://docs.x.com/x-api/posts/*`, `/users/*`, `/lists/*`, `/spaces/*` (`.md`) — each embeds
  the authoritative OpenAPI 3.0 YAML (spec `2.166`): param names, `required`, min/max, defaults,
  and per-operation `security` (BearerToken / OAuth2UserToken+scopes / UserToken=OAuth1.0a).
- `https://docs.x.com/x-api/getting-started/about-x-api`, `.../fundamentals/fields`,
  `.../fundamentals/pagination`, `.../posts/search/*` — fields/expansions/pagination/operators.
- `https://docs.x.com/x-api/introduction`, `/getting-started/pricing`, and the public
  changelog — pricing/tier context (pay-per-use + legacy Free/Basic/Pro/Enterprise).
- Machine-readable index: `https://docs.x.com/llms.txt`.
