import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  checkRange,
  describeReportError,
  fetchReport,
  formatCell,
  lastDays,
  layoutChart,
  rangeLength,
  reportUrl,
  rowsOf,
  shiftDay,
  toDay,
  totalOf,
} from './report.js';

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date('2026-11-25T10:30:00Z');

describe('days and ranges', () => {
  it('formats and shifts UTC days across month and year ends', () => {
    expect(toDay(new Date('2026-11-25T23:59:59Z'))).toBe('2026-11-25');
    expect(shiftDay('2026-03-01', 1)).toBe('2026-02-28');
    expect(shiftDay('2024-03-01', 1)).toBe('2024-02-29');
    expect(shiftDay('2026-01-01', 1)).toBe('2025-12-31');
    expect(shiftDay('2026-12-30', -3)).toBe('2027-01-02');
    expect(() => shiftDay('nope', 1)).toThrow();
  });

  it('builds the last N days ending today, both ends counted', () => {
    expect(lastDays(NOW, 7)).toEqual({ from: '2026-11-19', to: '2026-11-25' });
    expect(lastDays(NOW, 1)).toEqual({ from: '2026-11-25', to: '2026-11-25' });
    expect(rangeLength(lastDays(NOW, 30))).toBe(30);
  });

  it('measures a range and rejects reversed or impossible ones', () => {
    expect(rangeLength({ from: '2026-11-01', to: '2026-11-30' })).toBe(30);
    expect(rangeLength({ from: '2026-11-30', to: '2026-11-01' })).toBeUndefined();
    expect(rangeLength({ from: '2026-02-31', to: '2026-03-01' })).toBeUndefined();
    expect(rangeLength({ from: '', to: '2026-03-01' })).toBeUndefined();
  });

  it('explains the first problem with a range', () => {
    const ok = { from: '2026-11-01', to: '2026-11-25' };
    expect(checkRange(ok, 366, NOW)).toBeNull();
    expect(checkRange({ ...ok, from: '' }, 366, NOW)).toBe('Enter a start date.');
    expect(checkRange({ ...ok, to: 'x' }, 366, NOW)).toBe('Enter an end date.');
    expect(checkRange({ from: '2026-11-25', to: '2026-11-01' }, 366, NOW)).toBe(
      'The start date must not be after the end date.',
    );
    expect(checkRange({ from: '2026-11-01', to: '2026-11-26' }, 366, NOW)).toBe(
      'The end date cannot be in the future.',
    );
    expect(checkRange(ok, 10, NOW)).toBe('Choose at most 10 days.');
    expect(checkRange({ from: '2025-11-24', to: '2026-11-25' }, 366, NOW)).toBe(
      'Choose at most 366 days.',
    );
    expect(checkRange({ from: '2025-11-25', to: '2026-11-25' }, 366, NOW)).toBeNull();
  });
});

describe('fetching a report', () => {
  it('builds the plugin route URL with the range, escaping the plugin name', () => {
    expect(reportUrl('analytics', '/summary', { from: '2026-11-01', to: '2026-11-25' })).toBe(
      '/api/v1/plugins/analytics/summary?from=2026-11-01&to=2026-11-25',
    );
    expect(reportUrl('a/b', '/s', { from: '2026-11-01', to: '2026-11-02' })).toContain(
      '/plugins/a%2Fb/s?',
    );
  });

  it('returns the answer', async () => {
    const data = { totals: { views: 2 } };
    const fn = vi.fn(async (_url: string) => Response.json(data));
    vi.stubGlobal('fetch', fn);
    expect(await fetchReport('analytics', { route: '/summary' }, lastDays(NOW, 7))).toEqual(data);
    expect(fn.mock.calls[0]?.[0]).toBe(
      '/api/v1/plugins/analytics/summary?from=2026-11-19&to=2026-11-25',
    );
  });

  it('shows the message the route gave for a bad range, and plain sentences otherwise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'invalid_range', message: 'The range is too long.' }, { status: 400 }),
      ),
    );
    const error = await fetchReport('analytics', { route: '/summary' }, lastDays(NOW, 7)).catch(
      (e: unknown) => e,
    );
    expect(describeReportError(error)).toBe('The range is too long.');
    expect(describeReportError(new ApiError(403, 'forbidden'))).toMatch(/permission/);
    expect(describeReportError(new ApiError(404, 'not_found'))).toMatch(/not available/);
    expect(describeReportError(new ApiError(500, 'x'))).toMatch(/could not be loaded/);
    expect(describeReportError(new TypeError('network'))).toMatch(/reach the server/);
  });

  it('keeps the status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 403 })));
    const error = await fetchReport('analytics', { route: '/summary' }, lastDays(NOW, 7)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});

describe('reading the answer', () => {
  const data = {
    totals: { views: 1200, visitors: 'many' },
    pages: [{ path: '/a', views: 3 }, 'junk', null, ['x']],
    days: 'not a list',
  };

  it('reads totals only when they are finite numbers', () => {
    expect(totalOf(data, 'views')).toBe(1200);
    expect(totalOf(data, 'visitors')).toBeUndefined();
    expect(totalOf(data, 'nope')).toBeUndefined();
    expect(totalOf(undefined, 'views')).toBeUndefined();
    expect(totalOf({ totals: null }, 'views')).toBeUndefined();
  });

  it('reads row lists and ignores anything that is not a row', () => {
    expect(rowsOf(data, 'pages')).toEqual([{ path: '/a', views: 3 }]);
    expect(rowsOf(data, 'days')).toEqual([]);
    expect(rowsOf(data, 'missing')).toEqual([]);
  });

  it('formats cells', () => {
    expect(formatCell(1234567, true)).toBe('1,234,567');
    expect(formatCell(1234567)).toBe('1234567');
    expect(formatCell('/hello')).toBe('/hello');
    expect(formatCell(undefined)).toBe('');
    expect(formatCell({})).toBe('');
  });
});

describe('layoutChart', () => {
  const rows = [
    { day: '2026-11-23', views: 10, visitors: 5 },
    { day: '2026-11-24', views: 0, visitors: 0 },
    { day: '2026-11-25', views: 20, visitors: 'bad' },
  ];

  it('scales every bar to the biggest value and keeps rows in order', () => {
    const chart = layoutChart(rows, 'day', ['views', 'visitors'], { width: 300, height: 100 });
    expect(chart.max).toBe(20);
    expect(chart.groups.map((g) => g.label)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
    const [first, second, third] = chart.groups;
    expect(first!.bars[0]!.height).toBe(50);
    expect(first!.bars[0]!.y).toBe(50);
    expect(first!.bars[1]!.height).toBe(25);
    expect(second!.bars.map((b) => b.height)).toEqual([0, 0]);
    expect(third!.bars[0]!.height).toBe(100);
    expect(third!.bars[1]!.value).toBe(0);
  });

  it('keeps bars inside the chart and side by side without overlap', () => {
    const chart = layoutChart(rows, 'day', ['views', 'visitors'], { width: 300, height: 100 });
    for (const group of chart.groups) {
      const [a, b] = group.bars;
      expect(a!.x).toBeGreaterThanOrEqual(0);
      expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + 1e-9);
      expect(b!.x + b!.width).toBeLessThanOrEqual(300);
    }
  });

  it('draws a flat chart for no rows or all zeros', () => {
    expect(layoutChart([], 'day', ['views']).groups).toEqual([]);
    const flat = layoutChart([{ day: 'd', views: 0 }], 'day', ['views']);
    expect(flat.max).toBe(1);
    expect(flat.groups[0]!.bars[0]!.height).toBe(0);
  });
});
