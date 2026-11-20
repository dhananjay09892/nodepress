import { describe, expect, it } from 'vitest';
import { checkBudget, formatReport, percentile, type PerfFetch } from './perf.js';

describe('percentile', () => {
  it('uses the nearest rank and handles edge cases', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([3, 1, 2], 0)).toBe(1);
  });
});

/** A fake site and clock: each request advances the clock by `cost(path, n)` ms. */
function fake(options: {
  cost: (path: string, n: number) => number;
  status?: (path: string) => number;
  cache?: (path: string, n: number) => string | null;
}) {
  let time = 0;
  const calls = new Map<string, number>();
  const fetcher: PerfFetch = async (url) => {
    const path = new URL(url).pathname;
    const n = calls.get(path) ?? 0;
    calls.set(path, n + 1);
    time += options.cost(path, n);
    const cache = options.cache ? options.cache(path, n) : 'hit';
    return {
      status: options.status ? options.status(path) : 200,
      headers: { get: (name) => (name.toLowerCase() === 'x-nodepress-cache' ? cache : null) },
    };
  };
  return { fetcher, now: () => time, calls };
}

describe('checkBudget', () => {
  it('passes fast cached pages and warms the cache first', async () => {
    const site = fake({ cost: () => 5, cache: (_p, n) => (n === 0 ? 'miss' : 'hit') });
    const result = await checkBudget({
      fetch: site.fetcher,
      baseUrl: 'http://x.test/',
      paths: ['/', '/feed.xml'],
      samples: 10,
      now: site.now,
    });
    expect(result.failures).toEqual([]);
    expect(site.calls.get('/')).toBe(11);
    expect(result.reports[0]).toMatchObject({ path: '/', status: 200, cache: 'hit', samples: 10, medianMs: 5 });
    expect(formatReport(result)).toContain('Performance budget met');
  });

  it('fails when the median is over budget', async () => {
    const site = fake({ cost: () => 150 });
    const result = await checkBudget({ fetch: site.fetcher, baseUrl: 'http://x.test', paths: ['/'], samples: 5, now: site.now });
    expect(result.failures.some((f) => f.includes('median'))).toBe(true);
    expect(formatReport(result)).toContain('FAILED');
  });

  it('fails on a slow tail even when the median is fine', async () => {
    const site = fake({ cost: (_p, n) => (n % 10 === 0 && n > 0 ? 400 : 2) });
    const result = await checkBudget({ fetch: site.fetcher, baseUrl: 'http://x.test', paths: ['/'], samples: 20, now: site.now });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('p95');
  });

  it('fails a page that is not 200 or not served from the cache', async () => {
    const notFound = fake({ cost: () => 1, status: () => 404 });
    const a = await checkBudget({ fetch: notFound.fetcher, baseUrl: 'http://x.test', paths: ['/nope'], samples: 3, now: notFound.now });
    expect(a.failures[0]).toContain('answered 404');

    const uncached = fake({ cost: () => 1, cache: () => 'miss' });
    const b = await checkBudget({ fetch: uncached.fetcher, baseUrl: 'http://x.test', paths: ['/'], samples: 3, now: uncached.now });
    expect(b.failures[0]).toContain('not served from the page cache');

    const noHeader = fake({ cost: () => 1, cache: () => null });
    const c = await checkBudget({ fetch: noHeader.fetcher, baseUrl: 'http://x.test', paths: ['/'], samples: 3, now: noHeader.now });
    expect(c.failures[0]).toContain('no header');
  });

  it('honours a custom budget', async () => {
    const site = fake({ cost: () => 30 });
    const tight = await checkBudget({ fetch: site.fetcher, baseUrl: 'http://x.test', paths: ['/'], samples: 3, budgetMs: 20, now: site.now });
    expect(tight.failures.length).toBe(2);
  });
});
