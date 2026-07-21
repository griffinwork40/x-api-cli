import { describe, it, expect } from 'vitest';
import { redactSecrets, safeStringify, collectSecrets } from './redact.js';
import type { XClientConfig } from './types.js';

describe('redactSecrets', () => {
  it('redacts a single secret', () => {
    expect(redactSecrets('token is ABCD1234', ['ABCD1234'])).toBe('token is [REDACTED]');
  });

  it('redacts ALL occurrences of a secret', () => {
    expect(redactSecrets('ABCD1234 then ABCD1234', ['ABCD1234'])).toBe(
      '[REDACTED] then [REDACTED]',
    );
  });

  it('redacts MULTIPLE distinct secrets in one pass', () => {
    const str = 'bearer=BEARERTOKEN secret=APISECRET99 token=ACCESSTOKEN7';
    const out = redactSecrets(str, ['BEARERTOKEN', 'APISECRET99', 'ACCESSTOKEN7']);
    expect(out).not.toContain('BEARERTOKEN');
    expect(out).not.toContain('APISECRET99');
    expect(out).not.toContain('ACCESSTOKEN7');
    expect(out).toBe('bearer=[REDACTED] secret=[REDACTED] token=[REDACTED]');
  });

  it('skips secrets shorter than 4 chars', () => {
    expect(redactSecrets('a=abc b=abcd', ['abc', 'abcd'])).toBe('a=abc b=[REDACTED]');
  });

  it('skips undefined / empty entries without throwing', () => {
    expect(redactSecrets('hello VALIDSECRET', [undefined, '', 'VALIDSECRET'])).toBe(
      'hello [REDACTED]',
    );
  });

  it('escapes regex-special characters in a secret', () => {
    // A secret containing regex metacharacters must match literally, not as a pattern.
    const secret = 'a.b*c+d?(e)[f]';
    const str = `value=${secret} other=aXbYYcd`;
    const out = redactSecrets(str, [secret]);
    expect(out).toBe('value=[REDACTED] other=aXbYYcd');
  });

  it('returns the string unchanged when no secrets match', () => {
    expect(redactSecrets('nothing to hide', ['NOTPRESENT'])).toBe('nothing to hide');
  });
});

describe('safeStringify', () => {
  it('pretty-prints JSON and redacts secrets', () => {
    const data = { email: `user-SECRETKEY99@example.com`, id: '1' };
    const out = safeStringify(data, ['SECRETKEY99']);
    expect(out).not.toContain('SECRETKEY99');
    expect(out).toContain('[REDACTED]');
    // still valid pretty JSON (2-space indent)
    expect(out).toContain('\n  ');
  });
});

describe('collectSecrets', () => {
  it('gathers every credential the config holds', () => {
    const cfg: XClientConfig = {
      bearerToken: 'BEARER_XYZ',
      oauth2AccessToken: 'OAUTH2_XYZ',
      oauth1: {
        apiKey: 'APIKEY_XYZ',
        apiSecret: 'APISECRET_XYZ',
        accessToken: 'ACCESSTOKEN_XYZ',
        accessTokenSecret: 'ACCESSTOKENSECRET_XYZ',
      },
    };
    const secrets = collectSecrets(cfg);
    expect(secrets).toContain('BEARER_XYZ');
    expect(secrets).toContain('OAUTH2_XYZ');
    expect(secrets).toContain('APIKEY_XYZ');
    expect(secrets).toContain('APISECRET_XYZ');
    expect(secrets).toContain('ACCESSTOKEN_XYZ');
    expect(secrets).toContain('ACCESSTOKENSECRET_XYZ');
  });

  it('returns only populated creds (bearer-only config)', () => {
    const cfg: XClientConfig = { bearerToken: 'ONLY_BEARER' };
    const secrets = collectSecrets(cfg);
    expect(secrets).toEqual(['ONLY_BEARER']);
  });

  it('is usable directly by redactSecrets', () => {
    const cfg: XClientConfig = { bearerToken: 'MYBEARER123' };
    const out = redactSecrets('auth=MYBEARER123', collectSecrets(cfg));
    expect(out).toBe('auth=[REDACTED]');
  });
});
