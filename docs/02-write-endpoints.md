# X API v2 — Write / Manage Endpoints + Media Upload (Implementation Reference)

> Scope: the **write / manage** surface of the X API v2 (create/update/delete actions on behalf of a
> user) plus **media upload**. This is a CLI implementation reference: exact method + path, required
> body fields, OAuth 2.0 scopes, tier, and trimmed request/response samples. Read-only lookup (GET)
> endpoints are out of scope for this file.
>
> **Base host:** `https://api.x.com` (legacy `https://api.twitter.com` still resolves for the same
> `/2/...` paths). Media chunked/one-shot upload also lives under `https://api.x.com/2/media/...`.
>
> **Last verified:** 2026-07-20 against the official docs / OpenAPI spec (see "Sources" at bottom).

---

## ⚠️ READ THIS FIRST — auth, "user context", and tiers

### 1. Writes require USER CONTEXT. App-Only Bearer CANNOT post.

Every write/manage endpoint in this file acts *on behalf of a specific user* and therefore requires a
**user-context** credential. An **App-Only OAuth 2.0 Bearer token cannot create, delete, like, follow,
DM, or upload media** — it is read-only for public data. You must use one of:

| Auth method | How it appears in OpenAPI | Notes |
| --- | --- | --- |
| **OAuth 2.0 Authorization Code + PKCE** (recommended) | `OAuth2UserToken` with a scope list | Fine-grained scopes; access token expires in **2 hours**; add `offline.access` to get a refresh token (valid ~6 months). |
| **OAuth 1.0a User Context** (legacy) | `UserToken: []` | Still accepted on nearly every write endpoint; uses consumer key/secret + user access token/secret. No scope strings — permission is the app's Read/Write/DM level. **Bookmarks are OAuth2-only** (no `UserToken` alternative in the spec). |

- **OAuth 2.0 authorize URL:** `https://x.com/i/oauth2/authorize` (older host `https://twitter.com/i/oauth2/authorize` still works)
- **OAuth 2.0 token URL:** `https://api.x.com/2/oauth2/token`
- **Header on every write call:** `Authorization: Bearer <USER_ACCESS_TOKEN>` (OAuth2) and `Content-Type: application/json` for JSON bodies.
- For OAuth 2.0, a **confidential client** (Web App / Automated App / Bot) also sends HTTP Basic auth (client_id:client_secret) on the token exchange; **public clients** (Native / SPA) use PKCE only.

**Minimum practical OAuth 2.0 scope set for a posting CLI:**
`tweet.read tweet.write users.read offline.access` (add `media.write`, `like.write`, `follows.write`,
`dm.write`, `list.write`, `block.write`, `mute.write`, `bookmark.write` per feature — see each section).

### 2. Tiers — the FREE tier DOES allow posting (at a low cap)

> **Structural change (Feb 6, 2026):** X made **pay-per-usage** the default model for **new** developers.
> The classic **Free / Basic / Pro** subscription tiers are now **closed to new signups** but remain live
> for **existing (grandfathered) subscribers**. Both models are documented below because a CLI author may
> be on either. Enterprise is separate and negotiated.

| Tier | Post writes cap | Max post length | Status |
| --- | --- | --- | --- |
| **Free** (legacy) | **✅ writing allowed — ~500 posts / month** (app+user level), 24-hr windows | 280 chars | Closed to new signups; write-only stub (reads ~100/mo). As of Aug 2025 X **removed** `POST /2/users/:id/likes` and follow endpoints from Free. |
| **Basic** (legacy, **$200/mo**) | ~50,000 post writes / month (single user sub-capped ~3,000/mo) | 280 chars | Closed to new signups. (Launched $100 in 2023, raised to $200 Oct 2024.) |
| **Pro** (legacy, **$5,000/mo**) | ~300,000 post writes / month | 280 chars (see Premium note) | Closed to new signups. Adds full-archive search + filtered stream. |
| **Pay-per-use** (current default) | Post create ≈ **$0.015/req**; **with a URL ≈ $0.200/req** | 280 chars (see Premium note) | Default for new developers since Feb 2026. |
| **Enterprise** | Negotiated | — | Some endpoints are Enterprise-only (e.g. volume/likes streams; **blocks may be Enterprise-gated — see §5**). |

**Long-form posts (up to 25,000 chars):** the OpenAPI schema sets `TweetCreateRequest.text.maxLength =
25000`, but the 25k limit is **gated on the authoring account having X Premium**, *not* on the API tier.
Non-Premium accounts are effectively limited to 280 chars regardless of tier.

### 3. Key rate limits for writes (from the official rate-limit table)

| Method | Endpoint | Per App | Per User |
| --- | --- | --- | --- |
| POST | `/2/tweets` | 10,000 / 24 hrs | 100 / 15 min |
| DELETE | `/2/tweets/:id` | — | 50 / 15 min |
| POST | `/2/dm_conversations*` (all DM POSTs, shared) | — | 200 / 15 min |
| POST/DELETE | `/2/lists/:id/members*` | 300 / 15 min | 300 / 15 min |

> On legacy **Free**, write windows were throttled to 24-hr buckets (community-reported ~17 requests/24h
> at the app level for `POST /2/tweets`); the official table publishes only the standard/paid numbers
> above and does **not** break out per-tier columns. Treat per-tier splits as unverified (see coverage gaps).

### 4. Standard response envelope

Success bodies are wrapped in `data`. Action toggles return a boolean (`liked`, `retweeted`,
`following`, `blocking`, `muting`, `bookmarked`, `deleted`). Errors use either a legacy
`{"errors":[...]}` array or an RFC 7807 `application/problem+json` body (`{"type","title","detail","status"}`).

---

## 1. Posts (Tweets)

### 1a. Create a Post — `POST /2/tweets`
- **Auth:** OAuth 2.0 user context — scopes **`tweet.read` + `tweet.write` + `users.read`** (or OAuth 1.0a user context). **App-Only Bearer is rejected.**
- **Tier:** Free (within the ~500/mo cap) and up. **Success:** `201 Created`.
- **Body:** `application/json`. No single field is strictly required by the schema, but a valid post needs **`text`** and/or **`media`** (a poll or quote can substitute). Several fields are mutually exclusive (see notes).

Body fields:

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string | The post content. `maxLength` 25000 (Premium-gated; else 280). |
| `reply` | object | `reply.in_reply_to_tweet_id` (**required when `reply` present**) — the Post being replied to. Also `reply.exclude_reply_user_ids[]`, `reply.auto_populate_reply_metadata`. |
| `quote_tweet_id` | string | ID of the Post to quote. Mutually exclusive with `card_uri`, `poll`, `media`, `direct_message_deep_link`. |
| `media` | object | `media.media_ids[]` (**required when `media` present**, 1–4 IDs from a prior upload). Also `media.tagged_user_ids[]` (≤10). Mutually exclusive with `quote_tweet_id`, `poll`, `card_uri`. |
| `poll` | object | `poll.options[]` (**required**, 2–4 strings) + `poll.duration_minutes` (**required**, 5–10080). Mutually exclusive with `media`, `quote_tweet_id`, `card_uri`. |
| `reply_settings` | enum | Who can reply: `following`, `mentionedUsers`, `subscribers`, `verified`. |
| `for_super_followers_only` | bool | Default `false`. |
| `nullcast` | bool | Promoted-only (not shown on timeline/to followers). Default `false`. |
| `geo` | object | `geo.place_id`. |
| `community_id` | string | Post to a Community (+ `share_with_followers` bool). |
| `paid_partnership` | bool | Labels the post as paid promotion. |
| `made_with_ai` | bool | Labels AI-generated media. |
| `card_uri` | string | Cards. Mutually exclusive with quote/poll/media/DM-deep-link. |
| `direct_message_deep_link` | string | Deep link into a DM. |
| `edit_options` | object | `edit_options.previous_post_id` (**required when present**) — turns the request into an **edit** of an existing Post (Premium; up to 5 edits within 30 min of creation, each yields a new ID). |

Request (basic):
```json
{ "text": "Hello from the X API v2!" }
```
Request (reply + media + poll examples):
```json
{ "text": "This is a reply!", "reply": { "in_reply_to_tweet_id": "1234567890" } }
```
```json
{ "text": "Photo of the day", "media": { "media_ids": ["1234567890123456789"] } }
```
```json
{ "text": "What's your favorite color?",
  "poll": { "options": ["Red", "Blue", "Green"], "duration_minutes": 1440 } }
```
Response (`201`):
```json
{ "data": { "id": "1445880548472328192", "text": "Hello from the X API v2!" } }
```

> Self-serve limits worth coding around: max **1 cashtag** per API post; replies are only permitted if
> the original author @mentioned or quoted the replying account. There is **no** `scheduled_at` — posts
> publish immediately.

### 1b. Delete a Post — `DELETE /2/tweets/:id`
- **Auth:** OAuth 2.0 — scopes **`tweet.read` + `tweet.write` + `users.read`** (or OAuth 1.0a). **Success:** `200`.
- **Path:** `id` = Post ID (must be authored by the authenticated user). **Body:** none.

Response (`200`):
```json
{ "data": { "deleted": true } }
```

---

## 2. Likes

### 2a. Like a Post — `POST /2/users/:id/likes`
- **Auth:** OAuth 2.0 — scopes **`like.write` + `tweet.read` + `users.read`** (or OAuth 1.0a). **Success:** `200`.
- **Path:** `id` = authenticated user's ID. **Body (required):** `{ "tweet_id": "<id>" }`.

Request / Response:
```json
{ "tweet_id": "1445880548472328192" }
```
```json
{ "data": { "liked": true } }
```

### 2b. Unlike a Post — `DELETE /2/users/:id/likes/:tweet_id`
- **Auth:** same scopes as 2a. **Path:** `id`, `tweet_id`. **Body:** none. **Success:** `200`.
```json
{ "data": { "liked": false } }
```

---

## 3. Reposts (Retweets)

> ⚠️ Reposts use the **`tweet.write`** scope — there is **no** `retweet.*` scope.

### 3a. Repost — `POST /2/users/:id/retweets`
- **Auth:** OAuth 2.0 — scopes **`tweet.read` + `tweet.write` + `users.read`** (or OAuth 1.0a). **Success:** `200`.
- **Path:** `id` = authenticated user's ID. **Body (required):** `{ "tweet_id": "<id>" }`.
```json
{ "tweet_id": "1445880548472328192" }
```
```json
{ "data": { "retweeted": true } }
```

### 3b. Undo Repost — `DELETE /2/users/:id/retweets/:source_tweet_id`
- **Auth:** same scopes as 3a. **Path:** `id`, **`source_tweet_id`** (OpenAPI param name; prose sometimes writes `:tweet_id`). **Body:** none. **Success:** `200`.
```json
{ "data": { "retweeted": false } }
```

---

## 4. Follows

### 4a. Follow a user — `POST /2/users/:id/following`
- **Auth:** OAuth 2.0 — scopes **`follows.write` + `tweet.read` + `users.read`** (or OAuth 1.0a). **Success:** `200`.
- **Path:** `id` = source (authenticated) user's ID. **Body (required):** `{ "target_user_id": "<id>" }`.
```json
{ "target_user_id": "2244994945" }
```
```json
{ "data": { "following": true, "pending_follow": false } }
```
> `pending_follow` is `true` when the target account is protected (request is pending). Field is
> **singular** (`pending_follow`), not `pending_follows`.
> Note: `POST /2/users/:id/likes` and the follow endpoints were **removed from the legacy Free tier** (Aug 2025).

### 4b. Unfollow a user — `DELETE /2/users/:source_user_id/following/:target_user_id`
- **Auth:** same scopes as 4a. **Path:** `source_user_id`, `target_user_id`. **Body:** none. **Success:** `200`.
```json
{ "data": { "following": false } }
```

---

## 5. Blocks & Mutes

### 5a. Block a user — `POST /2/users/:id/blocking`
- **Auth:** OAuth 2.0 — scopes **`block.write` + `tweet.read` + `users.read`** (or OAuth 1.0a). **Success:** `200`.
- **Path:** `id` = authenticated user's ID. **Body (required):** `{ "target_user_id": "<id>" }`.
```json
{ "target_user_id": "2244994945" }
```
```json
{ "data": { "blocking": true } }
```
> ⚠️ **Availability in flux:** the current X API overview marks endpoints on the block surface as
> potentially **Enterprise-only** on some mirrors of the docs. Treat block/unblock plan-availability as
> **not guaranteed on self-serve tiers** and verify against `docs.x.com` before shipping. (See coverage gaps.)

### 5b. Unblock a user — `DELETE /2/users/:source_user_id/blocking/:target_user_id`
- **Auth:** same scopes as 5a. **Path:** `source_user_id`, `target_user_id`. **Body:** none. **Success:** `200`.
```json
{ "data": { "blocking": false } }
```

### 5c. Mute a user — `POST /2/users/:id/muting`
- **Auth:** OAuth 2.0 — scopes **`mute.write` + `tweet.read` + `users.read`** (or OAuth 1.0a). **Success:** `200`.
- **Path:** `id` = authenticated user's ID. **Body (required):** `{ "target_user_id": "<id>" }`.
```json
{ "target_user_id": "2244994945" }
```
```json
{ "data": { "muting": true } }
```
> Mute-write rate cap is ~50 requests / 15 min on self-serve (community-reported). Keyword muting is
> **not** in the v2 API (only account muting).

### 5d. Unmute a user — `DELETE /2/users/:source_user_id/muting/:target_user_id`
- **Auth:** same scopes as 5c. **Path:** `source_user_id`, `target_user_id`. **Body:** none. **Success:** `200`.
```json
{ "data": { "muting": false } }
```

---

## 6. Bookmarks (write)

> ⚠️ Bookmark endpoints list **only** the `OAuth2UserToken` security scheme — there is **no OAuth 1.0a
> (`UserToken`) alternative** in the spec. OAuth 2.0 PKCE is required.

### 6a. Add a bookmark — `POST /2/users/:id/bookmarks`
- **Auth:** OAuth 2.0 only — scopes **`bookmark.write` + `tweet.read` + `users.read`**. **Success:** `200`.
- **Path:** `id` = authenticated user's ID. **Body (required):** `{ "tweet_id": "<id>" }`.
```json
{ "tweet_id": "1445880548472328192" }
```
```json
{ "data": { "bookmarked": true } }
```

### 6b. Remove a bookmark — `DELETE /2/users/:id/bookmarks/:tweet_id`
- **Auth:** same scopes as 6a. **Path:** `id`, `tweet_id`. **Body:** none. **Success:** `200`.
```json
{ "data": { "bookmarked": false } }
```

---

## 7. Direct Messages

> **Auth for ALL DM writes:** OAuth 2.0 — scopes **`dm.write` + `tweet.read` + `users.read`**
> (docs also advise including **`dm.read`** since it is "required with dm.write"). OAuth 1.0a user
> context is also accepted. **App-Only is not supported** (DMs are private). **Success:** `201 Created`.
> **Rate limit:** 200 requests / 15 min per user, **shared across all DM POST endpoints**.
>
> Attach media to any DM via `"attachments": [{ "media_id": "<id>" }]` (upload with `media.write` first,
> using DM media categories like `dm_image` / `dm_video` / `dm_gif`).

### 7a. Send DM to a user (1:1) — `POST /2/dm_conversations/with/:participant_id/messages`
- **Path:** `participant_id` = recipient user ID. Creates the 1:1 conversation if none exists.
- **Body:** `CreateMessageRequest` — needs `text` and/or `attachments`.
```json
{ "text": "Hello! This is a message from the API." }
```
```json
{ "data": { "dm_conversation_id": "123123123-456456456", "dm_event_id": "1146654567674912769" } }
```

### 7b. Send DM to an existing conversation — `POST /2/dm_conversations/:dm_conversation_id/messages`
- **Path:** `dm_conversation_id`. **Body:** same `CreateMessageRequest` (`text` and/or `attachments`).
```json
{ "text": "Adding another message to the conversation." }
```
```json
{ "data": { "dm_conversation_id": "1582103724607971328", "dm_event_id": "1122334455667788990" } }
```

### 7c. Create a conversation (group) — `POST /2/dm_conversations`
- **Body:** `CreateDmConversationRequest` — **required:** `conversation_type` (`"Group"`, case-sensitive) + `participant_ids[]` (excluding yourself) + `message` (`{ "text": ... }` and/or attachments).
```json
{
  "conversation_type": "Group",
  "participant_ids": ["944480690", "906948460078698496"],
  "message": { "text": "Welcome to our new group!" }
}
```
```json
{ "data": { "dm_conversation_id": "1346889436626259968", "dm_event_id": "128341038123" } }
```

> Related (delete, out of this file's create/manage focus but part of the DM write surface):
> **`DELETE /2/dm_events/:id`** removes a DM event for yourself — same `dm.write` scope.

---

## 8. Lists (manage)

> **Auth for ALL list writes:** OAuth 2.0 — scopes **`list.write` + `list.read` + `tweet.read` +
> `users.read`** (per the v2 authentication-mapping guide), or OAuth 1.0a user context.

### 8a. Create a List — `POST /2/lists`
- **Success:** `201` (create). **Body** (`ListCreateRequest`): **`name`** (required) + optional `description`, `private` (bool).
```json
{ "name": "Tech News", "description": "My favorite tech journalists", "private": false }
```
```json
{ "data": { "id": "1441162269824405510", "name": "Tech News" } }
```

### 8b. Update a List — `PUT /2/lists/:id`
- **Path:** `id`. **Body** (`ListUpdateRequest`, all optional): `name`, `description`, `private`. **Success:** `200`.
```json
{ "description": "Updated description" }
```
```json
{ "data": { "updated": true } }
```

### 8c. Delete a List — `DELETE /2/lists/:id`
- **Path:** `id` (must be owned by the authenticated user). **Body:** none. **Success:** `200`.
```json
{ "data": { "deleted": true } }
```

### 8d. Add a member — `POST /2/lists/:id/members`
- **Path:** `id` = List ID. **Body (required):** `{ "user_id": "<id>" }`. **Success:** `200`. **Rate:** 300 / 15 min.
```json
{ "user_id": "2244994945" }
```
```json
{ "data": { "is_member": true } }
```

### 8e. Remove a member — `DELETE /2/lists/:id/members/:user_id`
- **Path:** `id`, `user_id`. **Body:** none. **Success:** `200`. **Rate:** 300 / 15 min.
```json
{ "data": { "is_member": false } }
```

---

## 9. Media Upload

**Big picture:** upload the file first → receive a **`media_id`** → attach it to a Post via
`media.media_ids` (or to a DM via `attachments[].media_id`). There are now **two documented hosts**:

- ✅ **v2 media upload on `https://api.x.com/2/media/upload*`** — the **current, recommended** path.
  Auth: OAuth 2.0 user context with **`media.write`** (or OAuth 1.0a). Two flavors: **one-shot** (images/
  subtitles) and **chunked** (video/large media).
- ❌ **Legacy v1.1 `https://upload.twitter.com/1.1/media/upload.json`** — **RETIRED for self-serve
  tiers on 2025-06-09.** Use v2. (Documented below for context / Enterprise legacy only.)

### 9a. v2 one-shot upload (images/subtitles) — `POST /2/media/upload`
- **Auth:** OAuth 2.0 **`media.write`** (or OAuth 1.0a). **Success:** `200`. **Content-Type:** `multipart/form-data`.
- **Body:** `media` (file, **required**) + `media_category` (e.g. `tweet_image`, `dm_image`, `subtitles`); optional `media_type`, `additional_owners`, `shared`. (Schema: `MediaUploadRequestOneShot` — image/subtitle categories only; use the chunked flow for video/GIF/large files.)
```bash
# form fields: media=@photo.png, media_category=tweet_image
```
```json
{ "data": { "id": "1146654567674912769", "media_key": "3_1146654567674912769" } }
```

### 9b. v2 chunked upload (video / large media) — INIT → APPEND → FINALIZE → STATUS
All four require OAuth 2.0 **`media.write`** (or OAuth 1.0a).

**Step 1 — INIT: `POST /2/media/upload/initialize`** (JSON) — returns the `media_id`.
- Body: `media_type` (MIME, e.g. `video/mp4`, `image/png`), `total_bytes` (exact file size; max `17179869184` = **16 GiB** ceiling in schema), `media_category` (`amplify_video`, `tweet_gif`, `tweet_image`, `tweet_video`, `dm_gif`, `dm_image`, `dm_video`, `subtitles`); optional `shared`, `additional_owners`.
```json
{ "media_type": "video/mp4", "total_bytes": 15728640, "media_category": "tweet_video" }
```
```json
{ "data": { "id": "1146654567674912769", "media_key": "7_1146654567674912769", "expires_after_secs": 86400 } }
```

**Step 2 — APPEND: `POST /2/media/upload/:id/append`** (`multipart/form-data`) — one call per chunk.
- Path: `:id` = media_id. Body: `media` (binary chunk, required) + `segment_index` (**required, 0-based**, range 0–999). Chunk size ≤ 5 MB (use ~4–4.5 MB to leave room for multipart overhead). Returns empty `2xx`.
```bash
# segment_index=0, media=@chunk_0.bin  (repeat with 1, 2, ...)
```

**Step 3 — FINALIZE: `POST /2/media/upload/:id/finalize`** — no body.
- If the response contains `processing_info`, you must poll (Step 4) before attaching.
```json
{ "data": { "id": "1146654567674912769", "processing_info": { "state": "pending", "check_after_secs": 5 } } }
```

**Step 4 — STATUS: `GET /2/media/upload?media_id=:id`** (also accepts `command=STATUS`) — poll until done.
- States: `pending` → `in_progress` (has `progress_percent`) → `succeeded` | `failed`. Respect `check_after_secs`.
```json
{ "data": { "processing_info": { "state": "succeeded", "progress_percent": 100 } } }
```

**Step 5 — attach to a Post:**
```json
{ "text": "Video of the day", "media": { "media_ids": ["1146654567674912769"] } }
```

### 9c. Media limits & categories
| Media | Category | Limits (per current v2 / community-corroborated) |
| --- | --- | --- |
| Image | `tweet_image` / `dm_image` | ~5 MB (PNG/JPEG/WEBP); ~15 MB (GIF) — *byte limits corroborated, not on a live official page* |
| GIF | `tweet_gif` / `dm_gif` | Animated GIF |
| Video | `tweet_video` / `dm_video` / `amplify_video` | **≤ 512 MB**, ≤ 140s, ≤ 1920×1920 (MP4) |
| Chunk size | — | ≤ 5 MB per APPEND (use ~4.5 MB) |
| `total_bytes` | — | Schema ceiling **16 GiB** (`17179869184`) |

### 9d. Legacy v1.1 chunked upload (RETIRED for self-serve — 2025-06-09)
- **Host/path (historical):** `POST https://upload.twitter.com/1.1/media/upload.json`. A single endpoint driven by a **`command`** param: `INIT` → `APPEND` → `FINALIZE` → `STATUS`.
  - INIT: `command=INIT`, `media_type`, `total_bytes` (+ `media_category`).
  - APPEND: `command=APPEND`, `media_id`, `segment_index`, and `media` (binary) **or** `media_data` (base64).
  - FINALIZE/STATUS: `command=FINALIZE|STATUS`, `media_id`.
  - Simple (single POST) upload existed for images.
- **Auth:** historically **OAuth 1.0a user context** (the v2 `media.write`/OAuth 2.0 path is the modern story).
- **Status:** **closed for self-serve (Free/Basic/Pro) on 2025-06-09** (deprecation announced Mar 31 2025, extended to Jun 9 2025). The old v1.1 media reference pages now redirect to the getting-started page. Enterprise *may* retain access (unconfirmed). **`api.x.com/1.1/media/upload.json` was never a documented host** — the canonical legacy host is `upload.twitter.com/1.1/...`. **For new CLIs, use v2 (§9a/§9b).**

---

## 10. Articles (long-form)

X Articles allow Premium subscribers to publish rich-text, long-form content (up to 100,000 characters)
with headings, formatting, embedded media, and their own URL (`x.com/i/article/{id}`). Publishing an
article also creates a wrapper tweet that surfaces in followers' feeds.

### 10a. Create Draft Article

| | |
| --- | --- |
| **Method + path** | `POST /2/articles/draft` |
| **Auth** | User context (OAuth 2.0 PKCE or OAuth 1.0a); `tweet.write` + `tweet.read` + `users.read` scopes |
| **Tier** | Pro and above (Premium account required to publish; draft creation may work on lower tiers) |

**Body (JSON):**

```jsonc
{
  "title": "My Article",            // required — article title
  "content_state": {                 // required — DraftJS content_state object
    "blocks": [
      { "text": "Paragraph text", "key": "a1" }
    ],
    "entities": []
  },
  "cover_media": {                   // optional — cover image
    "media_id": "1234567890"         // from media upload
  }
}
```

**Response (201):** `{ "data": { "article_id": "1234567890123456789" } }`

**Notes:**
- The `content_state` uses DraftJS block/entity format (not markdown or plain text).
- Blocks support `inline_style_ranges` (bold/italic), `entity_ranges` (links/mentions/hashtags),
  and atomic block types for embedded media, tweets, and URLs.

### 10b. Publish Article

| | |
| --- | --- |
| **Method + path** | `POST /2/articles/{article_id}/publish` |
| **Auth** | User context (OAuth 2.0 PKCE or OAuth 1.0a); `tweet.write` + `tweet.read` + `users.read` scopes |
| **Tier** | Premium required (the authenticating user must have an active Premium subscription) |

**Response (200):** `{ "data": { "post_id": "1234567890123456789" } }`

The `post_id` is the wrapper tweet ID. Use `GET /2/tweets/{post_id}` to retrieve it.

### Reading articles (no dedicated read endpoint)

There is no `GET /2/articles/{id}` endpoint. To read article content, request the `article`
tweet field on the wrapper tweet:

```
GET /2/tweets/{post_id}?tweet.fields=article
```

Returns `article.title` and `article.plain_text` (the full body as plain text). Note that
`article.plain_text` may be absent on some article tweets. Use `expansions=article.cover_media`
to include cover image metadata.

---

## Quick scope → endpoint map (OAuth 2.0)

| Feature | Required OAuth 2.0 scopes |
| --- | --- |
| Create/delete Post, repost/undo repost | `tweet.read` `tweet.write` `users.read` |
| Like / unlike | `like.write` `tweet.read` `users.read` |
| Follow / unfollow | `follows.write` `tweet.read` `users.read` |
| Block / unblock | `block.write` `tweet.read` `users.read` |
| Mute / unmute | `mute.write` `tweet.read` `users.read` |
| Bookmark / unbookmark | `bookmark.write` `tweet.read` `users.read` *(OAuth2 only)* |
| DMs (send/create/delete) | `dm.write` (`dm.read`) `tweet.read` `users.read` |
| Lists (create/update/delete/members) | `list.write` `list.read` `tweet.read` `users.read` |
| Media upload (all v2) | `media.write` |
| Articles (draft/publish) | `tweet.write` `tweet.read` `users.read` |
| Refresh token (any long-lived CLI) | `offline.access` |

Full v2 OAuth 2.0 scope vocabulary (authorizationCode flow): `block.read`, `block.write`,
`bookmark.read`, `bookmark.write`, `dm.read`, `dm.write`, `follows.read`, `follows.write`, `like.read`,
`like.write`, `list.read`, `list.write`, `media.write`, `mute.read`, `mute.write`, `offline.access`,
`space.read`, `timeline.read`, `tweet.moderate.write`, `tweet.read`, `tweet.write`, `users.read`.

---

## Sources (official docs + OpenAPI spec)

- Create/Delete Post, scopes, body schema: `https://docs.x.com/x-api/posts/create-post`, `.../posts/manage-tweets/introduction`, `https://docs.x.com/x-api/posts/delete-post`
- Users write actions (likes/reposts/follows/blocks/mutes) endpoint tables + samples: `https://docs.x.com/x-api/users/mutes/introduction` and sibling likes/reposts/follows/blocks pages; scope blocks from the X OpenAPI spec (`OAuth2UserToken` security per operation)
- Bookmarks: `https://docs.x.com/x-api/users/create-bookmark`, `.../delete-bookmark`
- Direct Messages: `https://docs.x.com/x-api/direct-messages/manage/introduction`, `.../create-dm-conversation`, `.../create-dm-message-by-participant-id`, `.../create-dm-message-by-conversation-id`, `.../manage/integrate`
- Lists: `https://docs.x.com/x-api/lists/manage-lists/introduction`, `.../lists/create-list`, `.../update-list`, `.../delete-list`, `.../lists/list-members/introduction`
- Media (v2): `https://docs.x.com/x-api/media/introduction`, `.../media/upload-media` (one-shot), `.../media/media-upload-initialize|append|finalize`, `.../media/get-media-upload-status`, guide `.../media/quickstart/media-upload-chunked`
- Auth / scopes: `https://docs.x.com/x-api/fundamentals/authentication` (OAuth 2.0 PKCE), v2 authentication-mapping guide, full scope list mirrored from `openapi/x-api-openapi.json`
- Rate limits: `https://docs.x.com/x-api/fundamentals/rate-limits`
- Tiers / pricing / v1.1 media retirement: `https://docs.x.com/x-api/getting-started/pricing`, `.../getting-started/about-x-api`, `https://docs.x.com/x-api/migrate/overview`
- Doc index for discovery: `https://docs.x.com/llms.txt`
- Root docs: `https://developer.x.com/en/docs/x-api` and `https://docs.x.com/`

---

## Coverage gaps / not fully verified

1. **Blocks plan availability** — some current doc mirrors flag the block surface as potentially
   **Enterprise-only**; others show it as standard. The `block.write` scope is confirmed, but whether
   block/unblock is callable on self-serve tiers is **in flux** — re-confirm at implementation time.
2. **Free-tier per-user `POST /2/tweets` cap** — the "~500 posts/month" write figure and 24-hr windowing
   are documented/community-corroborated; the specific "17 requests/24h" number appears to be **app-level
   and community-sourced**, not in the current official rate-limit table (which publishes only standard/
   paid numbers with no per-tier columns).
3. **List write response shapes** — `POST /2/lists` (`{"data":{"id","name"}}`) and `DELETE`
   (`{"data":{"deleted":true}}`) are confirmed. `PUT /2/lists/:id` → `{"data":{"updated":true}}` and
   members → `{"data":{"is_member":true|false}}` are the schema-implied shapes; exact literal samples for
   PUT/members were inferred from the OpenAPI mutate-response schemas, not always a captured sample body.
4. **DELETE boolean values** (`liked:false`, `retweeted:false`, `following:false`, `blocking:false`,
   `muting:false`, `bookmarked:false`) are the semantic "undo" values of the shared mutate-response
   schemas; field *names* are confirmed, the `false` values are the expected (not always literally sampled) result.
5. **v1.1 legacy media exact byte limits & full param matrix** — the source pages now redirect away, so
   image/GIF byte limits are community-corroborated rather than live-official; video 512MB/140s/1920² and
   5MB chunk are consistent with current v2.
6. **v2 APPEND `segment_index` base** — schema range is `0–999` and working implementations use **0-based**;
   one doc location has been reported to ambiguously describe a 1-based start. Treat 0-based as correct.
7. **JS-rendered docs** — `docs.x.com` / `developer.x.com` render content client-side; scope blocks, paths,
   and schemas above were read from the underlying **OpenAPI spec** (`openapi/x-api-openapi.json`, exposed
   via docs mirrors) and official quickstart/reference pages. Re-verify against the live site before shipping
   given the active twitter.com→x.com migration and the Feb 2026 pricing-model change.
