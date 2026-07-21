import { describe, it, expect } from 'vitest';
import { UsageError, MissingCredentialsError, RateLimitError } from './errors.js';

describe('UsageError', () => {
  it('is an Error with name UsageError', () => {
    const e = new UsageError('bad flag');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UsageError);
    expect(e.name).toBe('UsageError');
    expect(e.message).toBe('bad flag');
  });
});

describe('MissingCredentialsError', () => {
  it('extends UsageError so a single instanceof UsageError catch covers it', () => {
    const e = new MissingCredentialsError('need X_BEARER_TOKEN');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UsageError);
    expect(e).toBeInstanceOf(MissingCredentialsError);
    expect(e.name).toBe('MissingCredentialsError');
    expect(e.message).toBe('need X_BEARER_TOKEN');
  });
});

describe('RateLimitError', () => {
  it('carries resetInSeconds and has name RateLimitError', () => {
    const e = new RateLimitError(42);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.name).toBe('RateLimitError');
    expect(e.resetInSeconds).toBe(42);
    // is NOT a UsageError (different exit code)
    expect(e).not.toBeInstanceOf(UsageError);
  });

  it('mentions the retry window in its default message', () => {
    const e = new RateLimitError(30);
    expect(e.message).toContain('30');
  });

  it('accepts a custom message', () => {
    const e = new RateLimitError(5, 'slow down');
    expect(e.message).toBe('slow down');
    expect(e.resetInSeconds).toBe(5);
  });
});
