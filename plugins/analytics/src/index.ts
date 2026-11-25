import { definePlugin } from '@nodepress/sdk';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createAnalytics,
  DailySalt,
  dayOf,
  isBot,
  MAX_RANGE_DAYS,
  normalizePath,
  optedOut,
  parseDay,
  readRetentionDays,
  referrerHost,
  shiftDay,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './analytics.js';

export * from './analytics.js';

/** The plugin's folder (with `plugin.json` and `migrations/`); the server runs the migrations. */
export const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));

const BASE = '/api/v1/plugins/analytics';
const PRUNE_JOB = 'analytics:prune';
const DAY_MS = 86_400_000;

/** A 1×1 transparent GIF, for the script-free fallback. */
export const PIXEL = Uint8Array.from(
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
);

/**
 * The script the page loads. It sends one beacon with the path and the external referrer, unless
 * the browser says Do Not Track or Global Privacy Control. No cookie, no storage, no fingerprinting.
 */
export const SCRIPT = `(function(){try{var n=navigator;if(n.doNotTrack==='1'||n.globalPrivacyControl)return;var r=document.referrer,u='${BASE}/hit?p='+encodeURIComponent(location.pathname)+(r?'&r='+encodeURIComponent(r):'');if(n.sendBeacon){n.sendBeacon(u)}else{fetch(u,{method:'POST',keepalive:true})}}catch(e){}})();\n`;

/** The tags added before `</body>`: the script, and a pixel for visitors without JavaScript. */
export function beaconHtml(path: string): string {
  const counted = normalizePath(path);
  if (counted === undefined) return '';
  return (
    `<script src="${BASE}/script.js" defer></script>` +
    `<noscript><img src="${BASE}/hit.gif?p=${encodeURIComponent(counted)}" alt="" width="1" height="1"></noscript>`
  );
}

/**
 * Privacy-friendly analytics. Counts page views per path, referrer host and day, and unique
 * visitors per day, without cookies and without storing IP addresses or user agents: a visitor
 * is a hash of address and browser made with a random salt that lives in memory for one day, so
 * the stored hashes of a past day cannot be matched to anyone, and they are deleted anyway.
 * Visitors who send Do Not Track or Global Privacy Control, and crawlers, are not counted.
 */
export default definePlugin({
  name: 'analytics',
  version: '0.0.0',
  description: 'Privacy-friendly page view and visitor counts: no cookies, no IP addresses stored',
  setup({ hooks, logger, admin, routes, jobs, db }) {
    if (!db) throw new Error('The analytics plugin needs a database');
    const analytics = createAnalytics(db, { salt: new DailySalt() });

    async function retentionDays(): Promise<number> {
      try {
        const settings = await admin.getSettings('settings', 'retention');
        return readRetentionDays(settings['retention_days']);
      } catch {
        return DEFAULT_RETENTION_DAYS;
      }
    }

    admin.addPage({
      id: 'settings',
      title: 'Analytics settings',
      description:
        'Page views and visitors are counted without cookies and without storing IP addresses.',
      panels: [
        {
          id: 'retention',
          title: 'Retention',
          fields: [
            {
              name: 'retention_days',
              type: 'number',
              label: 'Keep data for (days)',
              description: 'Older counts are deleted once a day.',
              min: 1,
              max: MAX_RETENTION_DAYS,
              integer: true,
              default: DEFAULT_RETENTION_DAYS,
            },
          ],
        },
      ],
    });
    admin.addPage({
      id: 'overview',
      title: 'Analytics',
      description: 'Page views and visitors. Visitors are counted once per day, without cookies.',
      panels: [],
      report: {
        route: '/summary',
        defaultDays: 30,
        maxDays: MAX_RANGE_DAYS,
        totals: [
          { key: 'views', label: 'Page views' },
          { key: 'visitors', label: 'Visitors' },
        ],
        chart: {
          title: 'Per day',
          rows: 'days',
          x: 'day',
          series: [
            { key: 'views', label: 'Page views' },
            { key: 'visitors', label: 'Visitors' },
          ],
        },
        tables: [
          {
            rows: 'pages',
            title: 'Top pages',
            columns: [
              { key: 'path', label: 'Page' },
              { key: 'views', label: 'Page views', numeric: true },
            ],
          },
          {
            rows: 'referrers',
            title: 'Top referrers',
            columns: [
              { key: 'host', label: 'Referrer' },
              { key: 'views', label: 'Page views', numeric: true },
            ],
          },
        ],
      },
    });
    admin.addMenuItem({ id: 'analytics', label: 'Analytics', page: 'overview', order: 80 });
    admin.addMenuItem({
      id: 'analytics-settings',
      label: 'Analytics settings',
      page: 'settings',
      order: 81,
    });

    // The beacon never fails the page: a hit that cannot be stored is logged and forgotten.
    async function hit(
      request: Parameters<Parameters<typeof routes.add>[0]['handler']>[0],
    ): Promise<void> {
      const { headers, query } = request;
      if (optedOut(headers)) return;
      const userAgent = headers['user-agent'] ?? '';
      if (isBot(userAgent)) return;
      const path = normalizePath(query['p']);
      if (path === undefined) return;
      try {
        await analytics.record({
          ip: request.clientIp ?? 'unknown',
          userAgent,
          path,
          referrer: referrerHost(query['r'], headers['host']),
        });
      } catch (error) {
        logger.warn('Could not store a page view', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    routes.add({
      method: 'GET',
      path: '/hit.gif',
      capability: 'public',
      handler: async (request) => {
        await hit(request);
        return {
          bytes: PIXEL,
          headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' },
        };
      },
    });
    routes.add({
      method: 'POST',
      path: '/hit',
      capability: 'public',
      handler: async (request) => {
        await hit(request);
        return { status: 204 };
      },
    });
    routes.add({
      method: 'GET',
      path: '/script.js',
      capability: 'public',
      handler: () => ({
        text: SCRIPT,
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      }),
    });
    routes.add({
      method: 'GET',
      path: '/summary',
      capability: 'manage_options',
      handler: async ({ query }) => {
        const today = dayOf(new Date());
        const to = query['to'] === undefined ? today : parseDay(query['to']);
        const from = query['from'] === undefined ? undefined : parseDay(query['from']);
        if (to === undefined || (query['from'] !== undefined && from === undefined)) {
          return {
            status: 400,
            json: { error: 'invalid_range', message: 'Use dates like 2026-11-24.' },
          };
        }
        const start = from ?? shiftDay(to, 29);
        if (
          start > to ||
          Date.parse(`${to}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) >
            (MAX_RANGE_DAYS - 1) * DAY_MS
        ) {
          return {
            status: 400,
            json: {
              error: 'invalid_range',
              message: `"from" must not be after "to", and the range is at most ${MAX_RANGE_DAYS} days.`,
            },
          };
        }
        return { json: await analytics.summary(start, to) };
      },
    });

    // Pages load the script (and the pixel fallback) through the final HTML filter.
    hooks.addFilter('render:html', (html: unknown, context: unknown) => {
      const path = (context as { path?: unknown } | undefined)?.path;
      const tags = typeof path === 'string' ? beaconHtml(path) : '';
      const text = String(html);
      const end = text.toLowerCase().lastIndexOf('</body>');
      return tags === '' || end < 0 ? text : `${text.slice(0, end)}${tags}${text.slice(end)}`;
    });

    // Old rows are deleted once a day. The chain is tagged with this start's id, so a job left
    // over from an earlier start ends instead of running a second chain.
    if (jobs) {
      const chain = randomUUID();
      jobs.registerJob<{ chain?: string }>({
        type: PRUNE_JOB,
        handler: async (payload) => {
          if (payload?.chain !== chain) return;
          try {
            await analytics.prune(await retentionDays());
          } catch (error) {
            logger.error('Could not prune old analytics rows', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await jobs.enqueue(PRUNE_JOB, { chain }, { delayMs: DAY_MS });
        },
      });
      jobs.enqueue(PRUNE_JOB, { chain }, { delayMs: 60_000 }).catch((error: unknown) => {
        logger.warn('Could not schedule the analytics pruning job', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  },
});
