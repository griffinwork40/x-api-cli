# X API (formerly Twitter API) — Auth & Fundamentals

> Implementation-oriented reference for building a CLI wrapper against the **current X API (v2 primary)**.
> Focus is on exact auth headers, credential names, param names, base URLs, and response/error shapes.
>
> **Primary authoritative sources** (verified for this document; see per-claim citations inline):
> - X API docs (current): <https://docs.x.com/>  — every page also available as raw Markdown by appending `.md` to the URL, and a full LLM index lives at <https://docs.x.com/llms.txt>
> - X Developer docs (legacy host, still live / redirects): <https://developer.x.com/en/docs/x-api> and `developer.twitter.com`
> - Developer Console (credentials + billing): <https://console.x.com/> and <https://developer.x.com/en/portal/dashboard>
>
> **Retrieval date:** 2026-07-20. **⚠️ Time-sensitive:** X API pricing/access has changed repeatedly (2023, Oct 2024, and a 2026 pay-per-use migration). Treat all dollar figures and tier caps as *subject to change*; the console is the only authoritative source for live rates and your account's actual limits. Where a fact could not be confirmed on official docs it is marked **[UNVERIFIED — official]**.

---

## Overview & versioning

**Two API versions coexist:**

| Version | Status | Notes |
|---|---|---|
| **X API v2** | **Recommended / primary** | Modern JSON, fields/expansions, all new endpoints, pay-per-usage billing. Use for everything new. Source: <https://docs.x.com/x-api/getting-started/about-x-api> |
| **X API v1.1** | **Legacy** | Limited support; a few specialized/media endpoints historically required it. Migrate to v2. Source: same page + <https://docs.x.com/x-api/migrate/overview> |

**Base URLs** (v2 endpoints; both hostnames are live and equivalent — `api.x.com` is the current canonical host, `api.twitter.com` is the historical host still serving traffic):

```
https://api.x.com/2         ← canonical (use this)
https://api.twitter.com/2   ← legacy host, still functional
```

- Canonical example from official docs: `curl "https://api.x.com/2/users/by/username/xdevelopers" -H "Authorization: Bearer $BEARER_TOKEN"` (source: <https://docs.x.com/x-api/getting-started/getting-access>).
- Official `llms.txt` states: *"All endpoints use: `https://api.x.com/2/`"* (source: <https://github.com/xdevplatform/samples/blob/main/llms.txt>).
- Note: the RFC 7807 error `type` URIs are still namespaced under `https://api.twitter.com/2/problems/...` (see [Response & error envelope](#response--error-envelope)) — do not assume the host swap propagated everywhere.

**Auth-server endpoints** (not under `/2` path prefix uniformly — note exact paths):

```
POST https://api.x.com/oauth2/token              ← App-Only Bearer (client_credentials)  [legacy path, still documented]
GET  https://api.x.com/2/oauth2/authorize        ← OAuth 2.0 user-context authorize URL
POST https://api.x.com/2/oauth2/token            ← OAuth 2.0 user-context token + refresh exchange
POST https://api.x.com/oauth2/invalidate_token   ← revoke an App-Only Bearer token
```
(Sources: App-only auth page <https://docs.x.com/fundamentals/authentication/oauth-2-0/application-only>; OAuth2UserToken security scheme in the OpenAPI shows `authorizationUrl: https://api.x.com/2/oauth2/authorize`, `tokenUrl: https://api.x.com/2/oauth2/token`.)

**v1.1 media host (legacy):** `https://upload.twitter.com/1.1/media/upload.json`. **X deprecated the v1.1 media upload endpoint on ~2025-03-31** and migrated media to v2 (`POST /2/media/upload`). OAuth 1.0a clients may still reach v1.1 in practice, but new work should use the v2 media endpoints. **[UNVERIFIED — official]** on the exact deprecation date via docs.x.com (widely reported; corroborated by community/SDK sources such as <https://github.com/fastmcp-me/x-mcp-server> and <https://www.rapidevelopers.com/api-automations/how-to-automate-twitter-post-scheduling-using-the-api>). The v2 media flow is documented at <https://docs.x.com/x-api/media/introduction>.

**Endpoint path shape:** REST, resource-oriented, all under `/2`. Path params use `:id` in docs (literal is the numeric ID). Examples:

```
GET    /2/tweets/:id
GET    /2/tweets/:id/liking_users
POST   /2/tweets
DELETE /2/tweets/:id
GET    /2/users/by/username/:username
GET    /2/users/me
POST   /2/users/:id/likes
GET    /2/tweets/search/recent
GET    /2/tweets/search/stream
POST   /2/media/upload
```
(All from the v2 authentication-mapping table: <https://docs.x.com/resources/fundamentals/authentication/guides/v2-authentication-mapping>.)

---

## Access tiers

> **⚠️ Headline (read this first).** As of the current docs, the X API's **default and primary commercial model is pay-per-usage credits** purchased at <https://console.x.com/>, **plus Enterprise**. The older **Free / Basic / Pro subscription tiers are legacy** — the current official docs at docs.x.com **no longer document Free/Basic/Pro tier tables**, and new signups go to pay-per-use. Legacy Basic subscribers are reported to auto-migrate to pay-per-use. Because the CLI is being built *now*, design for **(a) pay-per-use billing** and **(b) Enterprise** as the real targets, and treat the tier caps below as historical context, not a build target.

### A. Pay-per-usage (current default model — official, verifiable)

No subscription; buy credits, pay per resource read / per write request. Source: <https://docs.x.com/x-api/getting-started/pricing>.

**Read operations** — charged **per resource returned**:

| Resource | Unit cost |
|---|---|
| Posts: Read | $0.005 / resource |
| User: Read | $0.010 / resource |
| DM Event: Read | $0.010 / resource |
| Following/Followers: Read | $0.010 / resource |
| List / Space / Community / Note: Read | $0.005 / resource |
| Like / Mute / Block: Read | $0.001 / resource |
| **Owned Reads** (your own posts/followers/bookmarks/likes/lists, when `{id}` = authenticated app owner) | **$0.001 / resource** |

**Write operations** — charged **per request**:

| Action | Unit cost |
|---|---|
| Post: Create | $0.015 / request |
| Post: Create (with URL) | $0.200 / request |
| DM Interaction: Create | $0.015 / request |
| User Interaction: Create | $0.015 / request |
| Interaction: Delete | $0.010 / request |
| List: Create | $0.010 / request |
| Bookmark | $0.005 / request |

- **Deduplication:** the same resource requested again within the **same 24-hour UTC window** is only charged once (resets at midnight UTC).
- **Controls:** credit balance + auto-recharge (min one top-up per 5-min window; paused at ≤$0 balance) + a per-billing-cycle **spending limit** that blocks requests when hit.
- **Usage endpoint:** track daily Post consumption via <https://docs.x.com/x-api/usage/introduction>.
- A monthly cap (reported ~2M post reads / cycle, above which you need Enterprise) exists but is **[UNVERIFIED — official]** on the pricing page text captured here.

### B. Enterprise (official — the high-volume path)

Custom pricing/volume, dedicated access (Account Activity, X Activity / XAA, GNIP/PowerTrack, full-archive at scale). Index: <https://docs.x.com/enterprise-api/llms.txt>. Exact pricing is sales-gated and **[UNVERIFIED — official]** (public reports cite ~$42k+/mo; not confirmable on docs).

### C. Legacy subscription tiers (historical — NOT on current official docs)

These numbers are **not present on current docs.x.com** and are compiled from reputable secondary reporting (TechCrunch) and third-party guides. **[UNVERIFIED — official]** for all figures. Kept for context because many existing integrations and blog posts still reference them.

| Tier | Monthly price | Post READ cap/mo | Post WRITE cap/mo | Projects / Apps |
|---|---|---|---|---|
| **Free** | $0 | ~none (≈100 read requests, experimental) | ~500 writes/mo (was 1,500) | 1 / 1 |
| **Basic** | ~$200/mo | ~15,000 | ~50,000 | 1 / 2 |
| **Pro** | ~$5,000/mo | ~1,000,000 | ~300,000 | 1 / 3 |
| **Enterprise** | custom (~$42k+ reported) | custom (50M+) | custom | custom |

Sources (secondary): TechCrunch 2024-10-30 (Basic $100→$200, reads 10k→15k, Free writes 1,500→500 + ~100 read req); TechCrunch 2023-03-29 (introduction of Free/Basic/Enterprise).

### What the FREE tier can and cannot do (critical for a CLI user who may only have Free)

- **Cannot meaningfully READ public data.** Free lost general read access in early 2023. Most **read** endpoints — recent/full-archive search, timelines, user/tweet lookups, followers/following — **require a paid path (Basic+ historically, or pay-per-use credits now).** [UNVERIFIED — official on exact request counts, but the "reads require paid" direction is well established.]
- **Was effectively write-limited:** on the order of a few hundred posts/month. Free also had features **removed over time** (e.g. likes/follows writes were pulled from Free in 2025 per the changelog <https://docs.x.com/changelog>).
- `GET /2/users/me` (self lookup) historically worked on limited access and is the safest "does my auth work?" probe.
- **Bottom line for the CLI:** assume that on a free/no-credit account, **reads and most writes will fail** (`403 client-forbidden` / `usage-capped`). Detect this explicitly (see [error envelope](#response--error-envelope)) and surface a clear "this requires paid access / credits" message rather than retrying.

---

## Authentication methods

X v2 supports **three** auth methods. Which one an endpoint accepts is defined by the **authentication mapping** (<https://docs.x.com/resources/fundamentals/authentication/guides/v2-authentication-mapping>). General rule:

- **App-Only Bearer** → read-only, public data, **no user context** (cannot post, cannot access DMs, cannot use `/2/users/me` in the general case, cannot search *users*). Also the **only** method accepted by streaming endpoints.
- **OAuth 2.0 user-context (PKCE)** → recommended for acting *as a user* (post, like, follow, bookmarks, DMs, `/2/users/me`), scoped.
- **OAuth 1.0a user-context** → also acts as a user; still required/accepted for some endpoints and is the classic media-upload signer.

### Endpoint → auth quick map (from the official mapping table)

| Endpoint (v2) | App-Only Bearer | OAuth 2.0 PKCE (user) | OAuth 1.0a (user) | Key scopes (OAuth2) |
|---|:--:|:--:|:--:|---|
| `GET /2/tweets`, `GET /2/tweets/:id` | ✅ | ✅ | ✅ | `tweet.read` `users.read` |
| `GET /2/tweets/search/recent` | ✅ | ✅ | ✅ | `tweet.read` `users.read` |
| `GET /2/tweets/search/all` (full-archive) | ✅ (Academic/Enterprise access) | — | — | — |
| `GET /2/tweets/search/stream` (filtered stream) | ✅ **only** | — | — | — |
| `GET /2/tweets/sample/stream` (volume stream) | ✅ **only** | — | — | — |
| `POST /2/tweets`, `DELETE /2/tweets/:id` | ❌ | ✅ | ✅ | `tweet.write` `tweet.read` `users.read` |
| `GET /2/users/me` | ❌ | ✅ | ✅ | `tweet.read` `users.read` |
| `GET /2/users/by/username/:username` (user lookup) | ✅ | ✅ | ✅ | `users.read` `tweet.read` |
| `POST /2/users/:id/likes` (like) | ❌ | ✅ | ✅ | `like.write` |
| `POST /2/users/:id/following` (follow) | ❌ | ✅ | ✅ | `follows.write` |
| `POST /2/users/:id/retweets` (repost) | ❌ | ✅ | ✅ | `tweet.write` |
| `GET /2/tweets/:id/bookmarks` / `POST /2/tweets/:id/bookmarks` | ❌ | ✅ | ❌ | `bookmark.read` / `bookmark.write` |
| `POST /2/media/upload` (media) | ❌ | ✅ | ✅ | `media.write` |
| DMs (`/2/dm_*`) | ❌ | ✅ | ✅ | `dm.read` `dm.write` |

(Source: <https://docs.x.com/resources/fundamentals/authentication/guides/v2-authentication-mapping>; media auth from the OpenAPI `security` block on <https://docs.x.com/x-api/media/upload-media>, which lists `OAuth2UserToken: [media.write]` and `UserToken` (= OAuth 1.0a).)

> **App-only cannot do (per official app-only page):** post Tweets/resources, **search for users**, use any geo endpoint, access Direct Messages or account credentials, retrieve user email addresses. Source: <https://docs.x.com/fundamentals/authentication/oauth-2-0/application-only>.

---

### (a) OAuth 2.0 App-Only / Bearer Token

**What it is:** OAuth 2.0 Client Credentials grant. App authenticates as *itself*, read-only, no user. Source: <https://docs.x.com/fundamentals/authentication/oauth-2-0/application-only>.

**How to get a Bearer Token — two ways:**

1. **Copy it from the Developer Console** — when you create an App you are shown a Bearer Token directly (Keys & Tokens tab). Simplest for a CLI.
2. **Generate it programmatically** from your API Key + Secret (consumer key/secret) via the token endpoint:

```
# Step 1: base64( urlencode(API_KEY) : urlencode(API_SECRET) )
#   -> call this BASIC_CREDS
# Step 2: exchange for a bearer token
curl -X POST "https://api.x.com/oauth2/token" \
  -H "Authorization: Basic <BASIC_CREDS>" \
  -H "Content-Type: application/x-www-form-urlencoded;charset=UTF-8" \
  --data "grant_type=client_credentials"
```

Success response:

```json
{ "token_type": "bearer", "access_token": "AAAAAAAAAAAAA...<the bearer token>" }
```
Verify `token_type == "bearer"`; `access_token` is your Bearer Token. Only one app-only token is valid at a time (re-requesting returns the same token until invalidated). Revoke via `POST https://api.x.com/oauth2/invalidate_token`. (All from the app-only page.)

**Exact header to call the API (no signing required):**

```http
Authorization: Bearer <BEARER_TOKEN>
```

Example:

```bash
curl "https://api.x.com/2/tweets/search/recent?query=from:xdevelopers" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"
```

**Can do:** read public timelines, user/tweet lookups, followers/following, lists, recent/full-archive search (with access), **filtered & volume streams (only Bearer works)**.
**Cannot do:** anything user-context — no posting, no likes/follows, no DMs, no `/2/users/me`, no user search, no geo, no email. Hitting a user-context endpoint with a Bearer token returns `403` with problem type `.../problems/unsupported-authentication` ("Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint").

---

### (b) OAuth 2.0 Authorization Code Flow with PKCE (user context)

**What it is:** the recommended way to act on behalf of a user, with fine-grained scopes. **Works with X API v2 only.** Enable OAuth 2.0 in the App's *User authentication settings* in the Console. Source: <https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>.

**Client types & the client secret:**
- **Public clients** (Native App, Single-page App) → no client secret; must send `client_id` in the token request body; PKCE mandatory.
- **Confidential clients** (Web App, Automated App / bot) → issued a **Client Secret**; authenticate the token exchange with HTTP Basic (`Authorization: Basic base64(client_id:client_secret)`) and then you don't need `client_id` in the body.

**Scopes** (request only what you need; space-delimited in the authorize URL). Full list from the OAuth 2.0 page:

```
tweet.read  tweet.write  tweet.moderate.write
users.read  users.email
follows.read  follows.write
like.read  like.write
mute.read  mute.write
block.read  block.write
bookmark.read  bookmark.write
list.read  list.write
space.read
dm.read  dm.write
media.write
offline.access        ← REQUIRED to receive a refresh token
```
(Source: <https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>. Note `timeline.read` also appears in the OpenAPI security scheme for custom timelines.)

**Token lifetimes:** access token ≈ **2 hours**. With `offline.access` you also get a **refresh token** to mint new access tokens without re-prompting. The `authorization_code` itself expires **30 seconds** after issuance — exchange it immediately.

**Flow (step-by-step):**

1. **Build the authorize URL** and send the user to it:

```
https://api.x.com/2/oauth2/authorize?
  response_type=code&
  client_id=<CLIENT_ID>&
  redirect_uri=<EXACT_MATCH_CALLBACK>&
  scope=tweet.read%20tweet.write%20users.read%20offline.access&
  state=<RANDOM_CSRF_STRING up to 500 chars>&
  code_challenge=<PKCE_CHALLENGE>&
  code_challenge_method=S256
```
`redirect_uri` must be **exact-match** to a callback registered in App settings. `code_challenge_method` is `S256` (recommended) or `plain`.

2. **User approves** → X redirects to your callback with `?code=<AUTH_CODE>&state=...`. Verify `state`.

3. **Exchange the code for tokens** (within 30s):

```bash
# Confidential client (Web App / Automated App): Basic auth, no client_id in body
curl -X POST "https://api.x.com/2/oauth2/token" \
  -H "Authorization: Basic $(printf '%s:%s' "$X_CLIENT_ID" "$X_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "grant_type=authorization_code" \
  --data "code=<AUTH_CODE>" \
  --data "redirect_uri=<EXACT_MATCH_CALLBACK>" \
  --data "code_verifier=<PKCE_VERIFIER>"

# Public client (Native/SPA): no secret, MUST include client_id in the body
curl -X POST "https://api.x.com/2/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "grant_type=authorization_code" \
  --data "client_id=$X_CLIENT_ID" \
  --data "code=<AUTH_CODE>" \
  --data "redirect_uri=<EXACT_MATCH_CALLBACK>" \
  --data "code_verifier=<PKCE_VERIFIER>"
```
(The Basic-auth-for-token-exchange detail is confirmed in the OpenAPI `tokenUrl` scheme and community references; the confidential-vs-public distinction is from the OAuth 2.0 page.)

Success response:

```json
{
  "token_type": "bearer",
  "expires_in": 7200,
  "access_token": "<USER_ACCESS_TOKEN>",
  "scope": "tweet.read tweet.write users.read offline.access",
  "refresh_token": "<REFRESH_TOKEN>"
}
```

4. **Refresh** (when access token expires; requires `offline.access` was granted):

```bash
curl -X POST "https://api.x.com/2/oauth2/token" \
  -H "Authorization: Basic $(printf '%s:%s' "$X_CLIENT_ID" "$X_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "grant_type=refresh_token" \
  --data "refresh_token=<REFRESH_TOKEN>"
```
Store the **new** `refresh_token` from the response (it may rotate). Public clients include `client_id` in the body instead of Basic auth.

**Exact header to call the API:**

```http
Authorization: Bearer <USER_ACCESS_TOKEN>
```
⚠️ This is the **same header shape** as the App-Only Bearer, but the *token value* represents a **user**, not the app. Do not swap them: an app Bearer in a user-context call fails; a user token used where only app-only is allowed also fails. **Grant types supported:** `authorization_code` (+PKCE) and `refresh_token` only.

---

### (c) OAuth 1.0a User Context

**What it is:** the classic three-legged, request-signing scheme. Acts on behalf of a user. Still accepted by nearly all user-context v2 endpoints and is the traditional signer for media upload. Sources: <https://docs.x.com/fundamentals/authentication/oauth-1-0a/api-key-and-secret> and the auth-mapping table.

**Credentials (four values):**
- **API Key & API Secret** — a.k.a. **Consumer Key & Secret**. Identify the App (its "username/password"). From App → Keys & Tokens.
- **Access Token & Access Token Secret** — identify the *user* the app acts as. For your own account you can generate these in the Console; for other users you run the 3-legged OAuth flow (`oauth/request_token` → user authorizes → `oauth/access_token`).

**Exact header (every request must be signed):**

```http
Authorization: OAuth
  oauth_consumer_key="<API_KEY>",
  oauth_token="<ACCESS_TOKEN>",
  oauth_signature_method="HMAC-SHA1",
  oauth_timestamp="<unix_seconds>",
  oauth_nonce="<unique_random>",
  oauth_version="1.0",
  oauth_signature="<PERCENT_ENCODED_HMAC_SHA1_SIGNATURE>"
```
(Header is a single line in practice — wrapped here for readability. The signature is an HMAC-SHA1 over a canonicalized signature base string using key `urlencode(API_SECRET)&urlencode(ACCESS_TOKEN_SECRET)`. See <https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/authorizing-a-request> and percent-encoding guide. **Use a library** — hand-rolling the signature is the #1 source of `401` errors.)

**Which endpoints need / accept it:**
- Accepted for essentially all user-context v2 actions (post/delete, likes, follows, retweets, mutes, blocks, lists, `/2/users/me`, DMs).
- **Media upload:** OAuth 1.0a is the classic signer. Current v2 `POST /2/media/upload` accepts **both** OAuth 1.0a (`UserToken`) and OAuth 2.0 (`media.write`) per the OpenAPI security block; the *legacy* v1.1 `upload.twitter.com/1.1/media/upload.json` flow is OAuth-1.0a-only and is deprecated (see [Overview](#overview--versioning)). Some third-party reports still find OAuth 1.0a most reliable for media — treat that as pragmatic guidance, not spec.
- **Bookmarks** are OAuth-2.0-only (not available to OAuth 1.0a) per the mapping table.

---

## Developer portal setup

Steps to obtain every credential (source: <https://docs.x.com/x-api/getting-started/getting-access>, <https://docs.x.com/fundamentals/authentication/oauth-1-0a/api-key-and-secret>, <https://docs.x.com/fundamentals/developer-apps>):

1. **Sign up** for a developer account and open the **Developer Console** (<https://console.x.com/> — the current console; <https://developer.x.com/en/portal/dashboard> is the legacy portal).
2. **Create a Project**, then **create an App** inside it. *(v2 requires keys/tokens from an App created inside a Project.)*
3. On App creation you are shown, **once**, the initial credentials — save them immediately:
   - **API Key & API Secret** (Consumer Key/Secret) → OAuth 1.0a app identity; also used to mint Bearer tokens.
   - **Bearer Token** → App-Only auth (read-only).
4. **Keys & Tokens** tab (find/regenerate later):
   - Regenerate **API Key/Secret** and **Bearer Token** here.
   - Generate your own user **Access Token & Secret** (OAuth 1.0a) here — set App permissions to **Read and write** (or **Read, write, and DM**) *before* generating, or the tokens will be read-only.
5. **User authentication settings** (enable OAuth 2.0):
   - Turn on **OAuth 2.0**; pick App type (**Web App / Automated App** = confidential → you get a **Client Secret**; **Native / SPA** = public → no secret).
   - Register **exact-match Callback URL(s)** (e.g. `http://127.0.0.1:8080/callback` for a local CLI) and a website URL.
   - After saving, the **Client ID** (and **Client Secret** for confidential clients) appear in Keys & Tokens.

Credential → source summary:

| Credential | Where it comes from | Enables |
|---|---|---|
| API Key & Secret (Consumer Key/Secret) | App creation / Keys & Tokens | OAuth 1.0a signing; minting Bearer tokens |
| Bearer Token | App creation / Keys & Tokens (or `oauth2/token`) | App-Only read-only |
| Access Token & Secret | Keys & Tokens (self) or 3-legged flow (other users) | OAuth 1.0a user context |
| Client ID & (Client Secret) | User authentication settings → Keys & Tokens | OAuth 2.0 PKCE user context |

---

## Recommended env var names for a CLI

A consistent, `X_`-prefixed set. Group by auth method so the CLI can validate "you have enough to do X":

```bash
# ── App-Only / Bearer (read-only public data; streams) ──────────────
export X_BEARER_TOKEN="AAAAAAAA..."        # Authorization: Bearer $X_BEARER_TOKEN

# ── OAuth 1.0a user context (post/like/follow/DM/media; legacy) ─────
export X_API_KEY="..."                     # a.k.a. consumer key
export X_API_SECRET="..."                  # a.k.a. consumer secret
export X_ACCESS_TOKEN="..."                # user access token
export X_ACCESS_TOKEN_SECRET="..."         # user access token secret

# ── OAuth 2.0 user context (PKCE; recommended for user actions) ─────
export X_CLIENT_ID="..."                   # OAuth 2.0 Client ID
export X_CLIENT_SECRET="..."               # only for confidential clients (Web/Automated App)
export X_OAUTH2_ACCESS_TOKEN="..."         # user access token from PKCE flow (Authorization: Bearer)
export X_OAUTH2_REFRESH_TOKEN="..."        # requires offline.access scope
export X_OAUTH2_REDIRECT_URI="http://127.0.0.1:8080/callback"   # must exact-match App settings
export X_OAUTH2_SCOPES="tweet.read tweet.write users.read offline.access"
```

**Which var group enables what:**

| Var group | Auth method | Capabilities |
|---|---|---|
| `X_BEARER_TOKEN` | OAuth 2.0 App-Only | Read public data; **filtered/volume streams**. No user actions. |
| `X_API_KEY` + `X_API_SECRET` + `X_ACCESS_TOKEN` + `X_ACCESS_TOKEN_SECRET` | OAuth 1.0a user context | Post/delete, like, follow, retweet, mute, block, lists, DMs, media, `/2/users/me`. |
| `X_CLIENT_ID` (+ `X_CLIENT_SECRET`) + `X_OAUTH2_ACCESS_TOKEN` (+ `X_OAUTH2_REFRESH_TOKEN`) | OAuth 2.0 PKCE user context | Same user actions as above **plus bookmarks**; scoped; recommended for new work. |

> **Design note:** keep the app-only Bearer and the OAuth 2.0 *user* access token in **separate** variables even though both go in `Authorization: Bearer` — they are different identities and mixing them is a common, silent failure. The names above match the de-facto convention in X's own sample repo (`BEARER_TOKEN`, `CLIENT_ID`/`CLIENT_SECRET`, `CONSUMER_KEY`/`CONSUMER_SECRET`) — the `X_`-prefixed names here are the recommended CLI-facing form; document the mapping if you also read the unprefixed ones. Source: <https://github.com/xdevplatform/samples/blob/main/README.md>.

---

## Rate limits

Source: <https://docs.x.com/resources/fundamentals/rate-limits> and the app-only page (rate-limit pools) and OAuth 2.0 page (per-app lookup bump). Per-endpoint tables live at <https://docs.x.com/x-api/fundamentals/rate-limits>.

**How limits work:**
- **Windowed:** most limits reset every **15 minutes**.
- **Two independent pools:**
  - **Per-app** limits apply to **Bearer / app-only** auth.
  - **Per-user** limits apply to **OAuth 1.0a or OAuth 2.0 user tokens**.
  - The pools are **separate** — app-only requests do not deplete user-context limits and vice versa.
- **Endpoint-specific:** each endpoint has its own cap (check the per-endpoint table). Example: Tweet lookup / User lookup per-app limit is **raised from 300 → 900 requests / 15 min** when using **OAuth 2.0**.
- Under pay-per-use, spend/usage caps (credit balance, spending limit, monthly cap) apply *in addition* to windowed rate limits.

**Response headers to read on every response:**

```http
x-rate-limit-limit:     <max requests in the current window>
x-rate-limit-remaining: <requests left in the current window>
x-rate-limit-reset:     <unix timestamp (seconds) when the window resets>
```

**429 behavior (Too Many Requests):**
- Exceeding a limit → HTTP **429**. Back off until `x-rate-limit-reset` (compute `reset - now` seconds), then retry.
- Prefer honoring `x-rate-limit-remaining` proactively (throttle before you hit 0) over reactively catching 429s.
- A `Retry-After` header may also be present on some limit responses — respect it if given.
- Usage/credit exhaustion surfaces separately as a problem-type response (e.g. `.../problems/usage-capped`, with `period` Daily/Monthly and `scope` Account/Product) rather than a plain 429 — handle both.

---

## Request conventions

### Pagination

Source: <https://docs.x.com/x-api/fundamentals/pagination>.

- **Request param:** `pagination_token` — set it to the value from the previous response.
- **Response `meta`:** `next_token` (next page) and `previous_token` (prior page). When `next_token` is **absent**, you've reached the end.
- **Page size:** `max_results` (default & max are **endpoint-specific** — check each endpoint's reference).
- **Ordering:** reverse chronological (newest first) within and across pages.
- Tokens are **opaque** — never parse/modify them; they may expire. Getting fewer than `max_results` does **not** mean you're done — keep going until no `next_token`.

```bash
# page 1
curl "https://api.x.com/2/users/2244994945/tweets?max_results=100" -H "Authorization: Bearer $X_BEARER_TOKEN"
# page 2 (using meta.next_token from page 1)
curl "https://api.x.com/2/users/2244994945/tweets?max_results=100&pagination_token=<NEXT_TOKEN>" -H "Authorization: Bearer $X_BEARER_TOKEN"
```

### Fields & expansions

Sources: <https://docs.x.com/x-api/fundamentals/fields>, <https://docs.x.com/x-api/fundamentals/expansions>.

**Fields** — v2 returns *minimal* data by default (a post returns only `id`, `text`, `edit_history_tweet_ids`). Ask for more with per-object `*.fields` params (comma-separated):

| Object | Param |
|---|---|
| Post (Tweet) | `tweet.fields` |
| User | `user.fields` |
| Media | `media.fields` |
| Poll | `poll.fields` |
| Place | `place.fields` |

**Expansions** — inline related objects (author, media, referenced posts, poll, place) into a top-level `includes` block via the `expansions` param. Common post expansions: `author_id`, `referenced_tweets.id`, `referenced_tweets.id.author_id`, `in_reply_to_user_id`, `attachments.media_keys`, `attachments.poll_ids`, `geo.place_id`, `entities.mentions.username`. (User: `pinned_tweet_id`; Space: `creator_id`,`host_ids`,`speaker_ids`; List: `owner_id`; DM: `sender_id`,`participant_ids`,`attachments.media_keys`.)

**How to pass them** — all as query params; `expansions` gives you the related object, the matching `*.fields` selects which of *its* fields you get:

```bash
curl "https://api.x.com/2/tweets/1234567890?\
expansions=author_id,attachments.media_keys&\
tweet.fields=created_at,public_metrics,conversation_id&\
user.fields=username,name,profile_image_url&\
media.fields=url,alt_text,type" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"
```

- Objects in `includes` carry **no positional link** to `data` — join them by ID (e.g. match `data.author_id` to `includes.users[].id`).
- Some fields require user context (e.g. **private metrics** like impressions/clicks on your own posts).
- Field order in responses is not guaranteed; a missing field means null/empty.

---

## Response & error envelope

Sources: v2 OpenAPI (`Problem` / `Error` schemas, e.g. <https://docs.x.com/x-api/posts/create-post> and `/2/users/me`), data dictionary <https://docs.x.com/x-api/fundamentals/data-dictionary/reference>, RFC 7807 (<https://datatracker.ietf.org/doc/html/rfc9457> supersedes 7807 but X still references 7807).

### Success envelope

Top-level keys a client should handle: **`data`**, **`includes`**, **`meta`**, and (sometimes, even on 2xx) **`errors`**.

- `data` — the primary result. An **object** for single-resource lookups, an **array** for collections.
- `includes` — expanded related objects, grouped by type: `includes.users[]`, `includes.tweets[]`, `includes.media[]`, `includes.polls[]`, `includes.places[]`.
- `meta` — collection metadata: `result_count`, `next_token`, `previous_token`, `newest_id`, `oldest_id` (endpoint-dependent).
- `errors` — **partial errors**: an array present *alongside* `data` when some requested items could not be returned (e.g. a deleted/suspended/not-authorized resource) while others succeeded. **The HTTP status can still be 200** — a client MUST inspect this array, not just the status code.

```json
{
  "data": [
    { "id": "1307025659294674945", "text": "Here's an article ...",
      "author_id": "2244994945", "created_at": "2020-09-18T18:36:15.000Z",
      "public_metrics": { "retweet_count": 11, "reply_count": 2, "like_count": 70, "quote_count": 1, "bookmark_count": 0, "impression_count": 430 } }
  ],
  "includes": {
    "users": [ { "id": "2244994945", "name": "X Dev", "username": "TwitterDev", "verified": true } ]
  },
  "meta": { "result_count": 1, "newest_id": "1307025659294674945", "oldest_id": "1307025659294674945", "next_token": "7140dibdnow9c7btw482..." }
}
```

Partial-error example (HTTP 200, `data` present *and* `errors` present):

```json
{
  "data": [ { "id": "123", "text": "..." } ],
  "errors": [
    {
      "value": "456",
      "detail": "Could not find tweet with ids: [456].",
      "title": "Not Found Error",
      "resource_type": "tweet",
      "parameter": "ids",
      "resource_id": "456",
      "type": "https://api.twitter.com/2/problems/resource-not-found"
    }
  ]
}
```

### Error envelope (request-level failures)

Two shapes exist; a robust client should parse both:

**1. RFC 7807 "Problem" object** (`Content-Type: application/problem+json`) — the v2 standard. Required members `type` + `title`; optional `detail`, `status` (+ per-type extensions). The HTTP status line is authoritative; `status` in the body mirrors it.

```json
{
  "title": "Unsupported Authentication",
  "detail": "Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint. Supported authentication types are [OAuth 1.0a User Context, OAuth 2.0 User Context].",
  "type": "https://api.twitter.com/2/problems/unsupported-authentication",
  "status": 403
}
```

**2. Legacy `Error` object** (`Content-Type: application/json`) — simpler `{code, message}`, seen on some endpoints/older paths:

```json
{ "errors": [ { "code": 32, "message": "Could not authenticate you." } ] }
```
(Some v2 responses wrap this as a top-level `errors` array; some auth endpoints return the bare object. The OpenAPI declares both `Error` (`code`+`message`) and `Problem` (RFC 7807) as possible `default`/error schemas.)

**Problem `type` URIs a CLI should special-case** (all under `https://api.twitter.com/2/problems/…`):

| `type` suffix | Typical HTTP | Meaning / CLI action |
|---|---|---|
| `unsupported-authentication` | 403 | Wrong auth method for this endpoint (e.g. Bearer on a user-context route). Switch auth. |
| `not-authorized-for-resource` / `client-forbidden` | 403 | No permission / access tier too low. Surface "requires paid/elevated access". |
| `not-authorized-for-field` | 403 | Field needs user context / higher access (e.g. private metrics). Drop the field. |
| `resource-not-found` | 404 (or 200 partial) | ID doesn't exist / deleted / suspended. |
| `invalid-request` | 400 | Malformed params. Fix the request. |
| `usage-capped` | 403/429 | Credit/quota cap hit (`period`: Daily/Monthly, `scope`: Account/Product). Stop; don't hammer. |
| `duplicate-rules` / `invalid-rules` / `rule-cap` | 400/422 | Filtered-stream rule problems. |
| `client-disconnected` / `operational-disconnect` / `streaming-connection` | — | Streaming lifecycle events; reconnect with backoff. |

**HTTP status conventions:** `200` OK (may still carry partial `errors`); `201` on create (e.g. `POST /2/tweets`); `400` bad request; `401` bad/missing auth (OAuth 1.0a signature errors, expired token); `403` forbidden (wrong auth type / insufficient access / policy); `404` not found; `429` rate/again with `x-rate-limit-*`; `5xx` server. **Client rule: check HTTP status → then always inspect the body for a top-level `errors` array (partial) or a Problem object (request-level).**

---

### Appendix — canonical smoke tests for a CLI

```bash
# 1) App-only Bearer works? (read public user)
curl -s "https://api.x.com/2/users/by/username/xdevelopers" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"

# 2) User context (OAuth2) works? (self) — expect 200 with your account
curl -s "https://api.x.com/2/users/me" \
  -H "Authorization: Bearer $X_OAUTH2_ACCESS_TOKEN"

# 3) Create a post (user context; expect 201) — OAuth2 (tweet.write) or OAuth1.0a
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"text":"hello from the CLI"}'
```
Interpretation: `/2/users/me` returning `401`/`403` with `unsupported-authentication` ⇒ you used the app Bearer (needs user context). A `403 client-forbidden`/`usage-capped` on reads ⇒ no paid access / no credits.
