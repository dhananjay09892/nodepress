/**
 * Performance budget check (N41): measures how fast a running site answers cached pages.
 * No dependencies. `perf-cli.ts` is the command CI runs; this file holds the testable parts.
 */

/** Time to first byte, in milliseconds, that cached pages must stay under (median and p95). */
export const DEFAULT_TTFB_BUDGET_MS = 100;
export const DEFAULT_SAMPLES = 30;

export interface PerfFetch {
  (url: string): Promise<{ status: number; headers: { get(name: string): string | null } }>;
}

export interface PathReport {
  path: string;
  status: number;
  /** The `X-NodePress-Cache` header of the measured requests (`hit` when served from cache). */
  cache: string | null;
  samples: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface BudgetResult {
  reports: PathReport[];
  /** Human-readable reasons the budget failed; empty when it passed. */
  failures: string[];
}

/** The value at percentile `p` (0 to 100) by the nearest-rank method; `0` for no samples. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1]!;
}

export interface MeasureOptions {
  fetch: PerfFetch;
  baseUrl: string;
  paths: readonly string[];
  samples?: number;
  budgetMs?: number;
  /** Clock in milliseconds; tests replace it. */
  now?: () => number;
}

/**
 * Request each path once to fill the page cache, then `samples` times more, timing how long the
 * answer takes to start (the fetch promise settles when the headers arrive). A path fails when
 * it does not answer 200, is not served from the cache, or its median or p95 exceeds the budget.
 */
export async function checkBudget(options: MeasureOptions): Promise<BudgetResult> {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const budget = options.budgetMs ?? DEFAULT_TTFB_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const base = options.baseUrl.replace(/\/+$/, '');
  const reports: PathReport[] = [];
  const failures: string[] = [];

  for (const path of options.paths) {
    const url = base + path;
    await options.fetch(url); // warm-up: the first request after a start is a cache miss
    const times: number[] = [];
    let status = 0;
    let cache: string | null = null;
    for (let i = 0; i < samples; i += 1) {
      const started = now();
      const response = await options.fetch(url);
      times.push(now() - started);
      status = response.status;
      cache = response.headers.get('x-nodepress-cache');
    }
    const report: PathReport = {
      path,
      status,
      cache,
      samples,
      medianMs: percentile(times, 50),
      p95Ms: percentile(times, 95),
      maxMs: times.length ? Math.max(...times) : 0,
    };
    reports.push(report);
    if (status !== 200) failures.push(`${path}: answered ${status}, expected 200`);
    else if (cache !== 'hit')
      failures.push(`${path}: not served from the page cache (${cache ?? 'no header'})`);
    if (report.medianMs > budget) {
      failures.push(
        `${path}: median ${report.medianMs.toFixed(1)} ms is over the ${budget} ms budget`,
      );
    }
    if (report.p95Ms > budget) {
      failures.push(`${path}: p95 ${report.p95Ms.toFixed(1)} ms is over the ${budget} ms budget`);
    }
  }
  return { reports, failures };
}

/** One line per path for the CI log. */
export function formatReport(result: BudgetResult): string {
  const lines = result.reports.map(
    (r) =>
      `${r.path}  status ${r.status}  cache ${r.cache ?? '-'}  median ${r.medianMs.toFixed(1)} ms  p95 ${r.p95Ms.toFixed(1)} ms  max ${r.maxMs.toFixed(1)} ms`,
  );
  lines.push(
    result.failures.length ? `FAILED:\n${result.failures.join('\n')}` : 'Performance budget met',
  );
  return lines.join('\n');
}
