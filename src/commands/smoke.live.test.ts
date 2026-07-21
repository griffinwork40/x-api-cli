import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../auth.js';
import { XClient } from '../client.js';
import type { XEnvelope, User } from '../types.js';

/**
 * OPT-IN LIVE SMOKE TEST — skipped by default (PLAN §5d).
 *
 * Runs ONLY when `X_LIVE_SMOKE=1` AND real credentials are present. Makes exactly one
 * real network call to confirm auth works end-to-end:
 *   • user token present → GET /2/users/me
 *   • else Bearer present → GET /2/users/by/username/xdevelopers
 *
 * Without the flag this whole block is skipped, so `pnpm test` / CI never touch the
 * network. Enable with, e.g.:
 *   X_LIVE_SMOKE=1 X_BEARER_TOKEN=… pnpm test
 */
const LIVE = process.env['X_LIVE_SMOKE'] === '1';

const hasUserToken =
  Boolean(process.env['X_OAUTH2_ACCESS_TOKEN']) ||
  (Boolean(process.env['X_API_KEY']) &&
    Boolean(process.env['X_API_SECRET']) &&
    Boolean(process.env['X_ACCESS_TOKEN']) &&
    Boolean(process.env['X_ACCESS_TOKEN_SECRET']));
const hasBearer = Boolean(process.env['X_BEARER_TOKEN']);
const hasAnyCreds = hasUserToken || hasBearer;

describe.skipIf(!LIVE || !hasAnyCreds)('live smoke (X_LIVE_SMOKE=1)', () => {
  it('authenticates against a real endpoint and returns a user', async () => {
    if (hasUserToken) {
      // User context → who am I?
      const cfg = resolveConfig(process.env, { needsUser: true });
      const client = new XClient(cfg);
      const env = (await client.get('/users/me', {
        'user.fields': 'username',
      })) as XEnvelope<User>;
      expect(env.data?.id).toBeTruthy();
    } else {
      // Bearer → public user lookup (app-only cannot call /users/me).
      const cfg = resolveConfig(process.env, {});
      const client = new XClient(cfg);
      const env = (await client.get('/users/by/username/xdevelopers')) as XEnvelope<User>;
      expect(env.data?.id).toBeTruthy();
    }
  }, 20_000);
});
