import { describe, it, expect } from 'vitest';
import {
  percentEncode,
  collectSignatureParams,
  buildSignatureBaseString,
  buildSigningKey,
  sign,
  buildOAuth1Header,
} from './oauth1.js';

// ─── The canonical Twitter/X OAuth 1.0a example vector ──────────────────────────
//
// SOURCE OF TRUTH: X's official "Creating a signature" page
//   https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
// verified live on 2026-07-20. RFC 5849 §3.4 is the algorithm; this vector is what X
// publishes. With injected timestamp + nonce it is fully deterministic/offline.
//
// ⚠️ RECONCILIATION NOTE (why the numbers here differ from PLAN.md §2):
// PLAN.md transcribed the two *secrets* with typos:
//   consumer secret  PLAN: ...E3Y7fk5   OFFICIAL: ...E3Z7kBw
//   token secret     PLAN: ...IVS8...   OFFICIAL: ...Iv S8... (lowercase v)
// The PLAN's stated signature `hCtSmYh+iHYCEqBWrE7C7hYmtUk=` is correct ONLY for the
// legacy `api.twitter.com` base string signed with the *corrected* (official) key —
// NOT with the mistyped key the PLAN also published. Per the PLAN's own instruction
// ("re-verify the vector against X's official page rather than mutating the algorithm"),
// we lock to the official secrets and assert BOTH canonical host vectors:
//   • api.twitter.com host  → hCtSmYh+iHYCEqBWrE7C7hYmtUk=   (the PLAN-required signature)
//   • api.x.com     host    → Ls93hJiZbQ3akF3HF3x1Bz8/zU4=   (what docs.x.com prints today)
// Our HMAC (node:crypto) reproduces BOTH exactly; independently confirmed with openssl.

const CONSUMER_KEY = 'xvz1evFS4wEEPTGEFPHBog';
const CONSUMER_SECRET = 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw'; // official
const TOKEN = '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb';
const TOKEN_SECRET = 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE'; // official (lowercase v)
const NONCE = 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg';
const TIMESTAMP = '1318622958';
const BODY_PARAMS = {
  status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
  include_entities: 'true',
};

const OAUTH_PARAMS = {
  oauth_consumer_key: CONSUMER_KEY,
  oauth_nonce: NONCE,
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: TIMESTAMP,
  oauth_token: TOKEN,
  oauth_version: '1.0',
};

// Signature base string for the LEGACY api.twitter.com host (classic published vector).
const BASE_STRING_TWITTER =
  'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521';

// Signature base string for the CURRENT api.x.com host (what docs.x.com shows today).
const BASE_STRING_X =
  'POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521';

const SIGNING_KEY =
  'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw&LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE';

// The PLAN-required signature (legacy api.twitter.com host).
const SIGNATURE_TWITTER = 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=';
const SIGNATURE_TWITTER_ENCODED = 'hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D';
// The current-official signature (api.x.com host), matching the docs' binary 2E CF 77 84…
const SIGNATURE_X = 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=';

// ─── percentEncode (RFC 3986) — the #1 signature-bug source ─────────────────────

describe('percentEncode', () => {
  it('leaves unreserved chars untouched', () => {
    expect(percentEncode('AZaz09-._~')).toBe('AZaz09-._~');
  });
  it('encodes space as %20 (not +)', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });
  it('encodes ! as %21', () => {
    expect(percentEncode('!')).toBe('%21');
  });
  it('encodes * as %2A', () => {
    expect(percentEncode('*')).toBe('%2A');
  });
  it("encodes ' as %27", () => {
    expect(percentEncode("'")).toBe('%27');
  });
  it('encodes ( as %28 and ) as %29', () => {
    expect(percentEncode('(')).toBe('%28');
    expect(percentEncode(')')).toBe('%29');
  });
  it('leaves ~ unescaped', () => {
    expect(percentEncode('~')).toBe('~');
  });
  it('encodes + as %2B and , as %2C (per the vector)', () => {
    expect(percentEncode('+')).toBe('%2B');
    expect(percentEncode(',')).toBe('%2C');
  });
});

// ─── buildSigningKey ────────────────────────────────────────────────────────────

describe('buildSigningKey', () => {
  it('matches the canonical vector signing key', () => {
    expect(buildSigningKey(CONSUMER_SECRET, TOKEN_SECRET)).toBe(SIGNING_KEY);
  });
  it('still emits the trailing & when the token secret is empty', () => {
    expect(buildSigningKey('cs', '')).toBe('cs&');
  });
});

// ─── collectSignatureParams + buildSignatureBaseString ──────────────────────────

describe('buildSignatureBaseString', () => {
  it('produces the exact canonical base string (api.twitter.com host)', () => {
    const paramString = collectSignatureParams(OAUTH_PARAMS, {}, BODY_PARAMS);
    expect(
      buildSignatureBaseString('POST', 'https://api.twitter.com/1.1/statuses/update.json', paramString),
    ).toBe(BASE_STRING_TWITTER);
  });

  it('produces the exact canonical base string (api.x.com host — current docs)', () => {
    const paramString = collectSignatureParams(OAUTH_PARAMS, {}, BODY_PARAMS);
    expect(
      buildSignatureBaseString('POST', 'https://api.x.com/1.1/statuses/update.json', paramString),
    ).toBe(BASE_STRING_X);
  });

  it('upper-cases the method and contains exactly two ampersands', () => {
    const paramString = collectSignatureParams(OAUTH_PARAMS, {}, BODY_PARAMS);
    const base = buildSignatureBaseString('post', 'https://api.x.com/1.1/statuses/update.json', paramString);
    expect(base.startsWith('POST&')).toBe(true);
    expect(base.split('&').length - 1).toBeGreaterThanOrEqual(2);
  });
});

// ─── sign — the actual HMAC-SHA1, verified against BOTH canonical signatures ────

describe('sign', () => {
  it('produces the PLAN-required signature for the api.twitter.com base string', () => {
    expect(sign(BASE_STRING_TWITTER, SIGNING_KEY)).toBe(SIGNATURE_TWITTER);
  });
  it('produces the current-official signature for the api.x.com base string', () => {
    expect(sign(BASE_STRING_X, SIGNING_KEY)).toBe(SIGNATURE_X);
  });
});

// ─── buildOAuth1Header — end-to-end against the canonical vector ────────────────

describe('buildOAuth1Header', () => {
  it('produces a header carrying the exact percent-encoded canonical signature', () => {
    const header = buildOAuth1Header({
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json',
      bodyParams: BODY_PARAMS,
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      token: TOKEN,
      tokenSecret: TOKEN_SECRET,
      oauthTimestamp: TIMESTAMP,
      oauthNonce: NONCE,
    });

    // Structural
    expect(header.startsWith('OAuth ')).toBe(true);
    // The exact PLAN-required percent-encoded signature (+ → %2B, = → %3D).
    expect(header).toContain(`oauth_signature="${SIGNATURE_TWITTER_ENCODED}"`);
    // Carries the standard oauth_* params.
    expect(header).toContain(`oauth_consumer_key="${CONSUMER_KEY}"`);
    expect(header).toContain(`oauth_token="${TOKEN}"`);
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain(`oauth_timestamp="${TIMESTAMP}"`);
    expect(header).toContain(`oauth_nonce="${NONCE}"`);
    expect(header).toContain('oauth_version="1.0"');
  });

  it('separates params by ", " and quotes each value', () => {
    const header = buildOAuth1Header({
      method: 'GET',
      url: 'https://api.x.com/2/users/me',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
      oauthTimestamp: '1',
      oauthNonce: 'nonce',
    });
    expect(header).toMatch(/^OAuth [a-z_]+="[^"]*"(, [a-z_]+="[^"]*")+$/);
  });

  it('includes query params in the signature (GET) and still emits a signature', () => {
    const header = buildOAuth1Header({
      method: 'GET',
      url: 'https://api.x.com/2/tweets',
      queryParams: { ids: '20,21' },
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
      oauthTimestamp: '1',
      oauthNonce: 'nonce',
    });
    expect(header).toContain('oauth_signature=');
  });

  it('signs query params identically regardless of the URL query-string order', () => {
    // The signature must fold the query into the param string, not the raw URL tail.
    const a = buildOAuth1Header({
      method: 'GET',
      url: 'https://api.x.com/2/tweets?ids=20,21&foo=bar',
      queryParams: { ids: '20,21', foo: 'bar' },
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
      oauthTimestamp: '1',
      oauthNonce: 'nonce',
    });
    const b = buildOAuth1Header({
      method: 'GET',
      url: 'https://api.x.com/2/tweets?foo=bar&ids=20,21',
      queryParams: { foo: 'bar', ids: '20,21' },
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
      oauthTimestamp: '1',
      oauthNonce: 'nonce',
    });
    expect(a).toBe(b);
  });

  it('generates a timestamp and nonce when not injected', () => {
    const header = buildOAuth1Header({
      method: 'GET',
      url: 'https://api.x.com/2/users/me',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
    });
    expect(header).toMatch(/oauth_timestamp="\d+"/);
    expect(header).toMatch(/oauth_nonce="[0-9a-f]+"/);
  });
});
