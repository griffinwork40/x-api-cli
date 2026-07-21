import { describe, it, expect, vi } from 'vitest';
import {
  buildQueryParams,
  formatJson,
  parsePositiveInt,
  sleep,
  addFieldFlags,
  collectFieldParams,
  paginate,
  parseMaxPages,
  assertOne,
} from './utils.js';
import { UsageError } from './errors.js';

describe('buildQueryParams', () => {
  it('drops undefined and null; coerces the rest to string', () => {
    const out = buildQueryParams({ a: 'x', b: 1, c: true, d: undefined, e: null, f: 0, g: false, h: '' });
    expect(out).toEqual({ a: 'x', b: '1', c: 'true', f: '0', g: 'false', h: '' });
    expect(out).not.toHaveProperty('d');
    expect(out).not.toHaveProperty('e');
  });
});

describe('formatJson', () => {
  it('pretty-prints with 2-space indent', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('parsePositiveInt', () => {
  it('parses a positive integer', () => {
    expect(parsePositiveInt('42', '--max-results')).toBe(42);
  });
  it('throws UsageError on zero', () => {
    expect(() => parsePositiveInt('0', '--max-results')).toThrow(UsageError);
  });
  it('throws UsageError on negative', () => {
    expect(() => parsePositiveInt('-3', '--max-results')).toThrow(UsageError);
  });
  it('throws UsageError on non-integer', () => {
    expect(() => parsePositiveInt('3.5', '--max-results')).toThrow(UsageError);
    expect(() => parsePositiveInt('abc', '--max-results')).toThrow(UsageError);
  });
  it('names the flag in the message', () => {
    expect(() => parsePositiveInt('0', '--max-results')).toThrow('--max-results');
  });
});

describe('sleep', () => {
  it('resolves after the given delay (fake timers)', async () => {
    vi.useFakeTimers();
    const p = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('addFieldFlags', () => {
  it('returns a parseArgs option spec for every field/expansion flag', () => {
    const spec = addFieldFlags();
    for (const flag of [
      'tweet-fields',
      'user-fields',
      'media-fields',
      'poll-fields',
      'place-fields',
      'space-fields',
      'list-fields',
      'topic-fields',
      'search-count-fields',
      'expansions',
    ]) {
      expect(spec[flag]).toEqual({ type: 'string' });
    }
  });
});

describe('collectFieldParams', () => {
  it('maps kebab flags to dotted API query keys', () => {
    const out = collectFieldParams({
      'tweet-fields': 'created_at,public_metrics',
      'user-fields': 'username',
      'media-fields': 'url',
      'poll-fields': 'options',
      'place-fields': 'country',
      'space-fields': 'title',
      'list-fields': 'member_count',
      'topic-fields': 'name',
      'search-count-fields': 'foo',
      expansions: 'author_id',
    });
    expect(out).toEqual({
      'tweet.fields': 'created_at,public_metrics',
      'user.fields': 'username',
      'media.fields': 'url',
      'poll.fields': 'options',
      'place.fields': 'country',
      'space.fields': 'title',
      'list.fields': 'member_count',
      'topic.fields': 'name',
      'search_count.fields': 'foo',
      expansions: 'author_id',
    });
  });

  it('omits absent flags', () => {
    const out = collectFieldParams({ 'tweet-fields': 'id' });
    expect(out).toEqual({ 'tweet.fields': 'id' });
    expect(Object.keys(out)).toHaveLength(1);
  });

  it('returns an empty object when nothing is set', () => {
    expect(collectFieldParams({})).toEqual({});
  });
});

describe('parseMaxPages', () => {
  it('parses a positive integer', () => {
    expect(parseMaxPages('5')).toBe(5);
  });
  it('throws UsageError on zero/negative/non-int', () => {
    expect(() => parseMaxPages('0')).toThrow(UsageError);
    expect(() => parseMaxPages('-1')).toThrow(UsageError);
    expect(() => parseMaxPages('x')).toThrow(UsageError);
  });
});

describe('assertOne', () => {
  it('returns the first positional', () => {
    expect(assertOne(['abc'], 'id')).toBe('abc');
  });
  it('throws UsageError when the positional is absent', () => {
    expect(() => assertOne([], 'id')).toThrow(UsageError);
  });
  it('names the argument in the error', () => {
    expect(() => assertOne([], 'tweet id')).toThrow('tweet id');
  });
});

describe('paginate', () => {
  it('collects a single page when there is no nextToken', async () => {
    const items = await paginate(
      async () => ({ items: [1, 2, 3], nextToken: undefined }),
      { all: true },
    );
    expect(items).toEqual([1, 2, 3]);
  });

  it('follows nextToken across pages until absent', async () => {
    const pages: Record<string, { items: number[]; nextToken?: string }> = {
      __first: { items: [1], nextToken: 'p2' },
      p2: { items: [2], nextToken: 'p3' },
      p3: { items: [3], nextToken: undefined },
    };
    const seen: (string | undefined)[] = [];
    const items = await paginate(
      async (token?: string) => {
        seen.push(token);
        return pages[token ?? '__first']!;
      },
      { all: true },
    );
    expect(items).toEqual([1, 2, 3]);
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });

  it('stops after maxPages even if a nextToken remains', async () => {
    let calls = 0;
    const items = await paginate(
      async () => {
        calls += 1;
        return { items: [calls], nextToken: 'always-more' };
      },
      { maxPages: 2 },
    );
    expect(items).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it('fetches only the first page when neither all nor maxPages is set', async () => {
    let calls = 0;
    const items = await paginate(
      async () => {
        calls += 1;
        return { items: [calls], nextToken: 'more' };
      },
      {},
    );
    expect(items).toEqual([1]);
    expect(calls).toBe(1);
  });
});
