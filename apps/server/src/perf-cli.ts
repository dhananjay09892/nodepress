import {
  checkBudget,
  DEFAULT_SAMPLES,
  DEFAULT_TTFB_BUDGET_MS,
  formatReport,
  type PerfFetch,
} from './perf.js';

/**
 * `node dist/perf-cli.js <base-url> [path ...]`: fails (exit 1) when a cached page is slower than
 * the budget. `PERF_BUDGET_MS` and `PERF_SAMPLES` override the defaults. Used by CI after a build.
 */
async function main(argv: string[]): Promise<number> {
  const [baseUrl, ...rest] = argv;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    console.error('Usage: perf-cli <base-url> [path ...]   e.g. perf-cli http://localhost:3000 / /feed.xml');
    return 2;
  }
  const number = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const result = await checkBudget({
    fetch: ((url) => fetch(url, { redirect: 'manual' })) as PerfFetch,
    baseUrl,
    paths: rest.length ? rest : ['/'],
    samples: Math.floor(number('PERF_SAMPLES', DEFAULT_SAMPLES)),
    budgetMs: number('PERF_BUDGET_MS', DEFAULT_TTFB_BUDGET_MS),
  });
  console.log(formatReport(result));
  return result.failures.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
