import type { PluginContext } from '@nodepress/sdk';
import { createHash, randomBytes } from 'node:crypto';

/** The plugin's own database (only present when the site has one to give). */
export type AnalyticsDb = NonNullable<PluginContext['db']>;

/** Days of data kept when the setting is missing or odd. */
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 3650;
/** Distinct (path, referrer) rows kept per day; further combinations count as `/other`. */
export const MAX_ROWS_PER_DAY = 2000;
export const MAX_PATH_LENGTH = 200;
export const MAX_RANGE_DAYS = 366;
export const OTHER_PATH = '/other';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `2026-11-24` (UTC) for a moment in time. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day `count` days before (or after, when negative) `day`. */
export function shiftDay(day: string, count: number): string {
  return dayOf(new Date(Date.parse(`${day}T00:00:00Z`) - count * DAY_MS));
}

/** A valid `YYYY-MM-DD` that exists on the calendar, or `undefined`. */
export function parseDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DAY.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || dayOf(new Date(time)) !== value ? undefined : value;
}

export function readRetentionDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, MAX_RETENTION_DAYS)
    : DEFAULT_RETENTION_DAYS;
}

// ── Who is counted ──────────────────────────────────────────────────────────────────────────

/** Visitors who ask not to be tracked (Do Not Track, Global Privacy Control) are not counted. */
export function optedOut(headers: Readonly<Record<string, string>>): boolean {
  return headers['dnt'] === '1' || headers['sec-gpc'] === '1';
}

/** Crawlers and monitors that say so in their user agent; an empty one is treated as a bot. */
const BOT_PATTERN =
  /bot\b|bot[/;)_ -]|crawl|spider|slurp|scrape|fetch|monitor|uptime|preview|lighthouse|pingdom|curl|wget|python-requests|httpclient|go-http-client|java\/|axios|node-fetch|okhttp|libwww|facebookexternalhit|whatsapp|telegram/i;

export function isBot(userAgent: string | undefined): boolean {
  const agent = (userAgent ?? '').trim();
  return agent === '' || BOT_PATTERN.test(agent);
}

/**
 * The salt that keeps visitor hashes from being linked across days. It exists only in memory,
 * for one UTC day: the next day gets a new random one and the old one is forgotten, so a hash
 * stored yesterday can no longer be reproduced (or matched to today's) by anyone, including us.
 */
export class DailySalt {
  #day: string | undefined;
  #salt: Buffer | undefined;
  readonly #random: () => Buffer;

  constructor(random: () => Buffer = () => randomBytes(32)) {
    this.#random = random;
  }

  /** The salt for `day`; asking for a different day than last time replaces it. */
  forDay(day: string): Buffer {
    if (this.#day !== day || !this.#salt) {
      this.#day = day;
      this.#salt = this.#random();
    }
    return this.#salt;
  }

  /** The day the current salt belongs to. */
  get day(): string | undefined {
    return this.#day;
  }
}

/** A hash of salt, address and browser that is only ever stored under the day it was made on. */
export function hashVisitor(salt: Buffer, ip: string, userAgent: string): string {
  return createHash('sha256')
    .update(salt)
    .update('\0')
    .update(ip)
    .update('\0')
    .update(userAgent)
    .digest('hex');
}

// ── What is counted ─────────────────────────────────────────────────────────────────────────

/**
 * The path that is counted: no query string or fragment, no trailing slash, at most 200
 * characters. Returns `undefined` for anything that is not a page of this site (not starting
 * with a single `/`, control characters, `/api` and `/admin`).
 */
export function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = value.split(/[?#]/)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith('/') || path.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(path)) {
    return undefined;
  }
  if (path.length > MAX_PATH_LENGTH) return undefined;
  if (/^\/(api|admin)(\/|$)/.test(path)) return undefined;
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

/** The host of an external referrer (`news.example.com`), or `''` for none or the site itself. */
export function referrerHost(value: unknown, siteHost: string | undefined): string {
  if (typeof value !== 'string' || value === '' || value.length > 2000) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const own = (siteHost ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  if (host === '' || host.length > 100 || host === own) return '';
  return host;
}

export interface Hit {
  /** `X-Forwarded-For` or socket address, used only to make today's hash. */
  ip: string;
  userAgent: string;
  path: string;
  referrer: string;
}

export interface Analytics {
  /** Count a page view and (once per day and visitor) a visitor. */
  record(hit: Hit): Promise<void>;
  /** Delete everything older than `retentionDays` days. */
  prune(retentionDays: number): Promise<void>;
  summary(from: string, to: string, topLimit?: number): Promise<Summary>;
}

export interface Summary {
  from: string;
  to: string;
  totals: { views: number; visitors: number };
  days: Array<{ day: string; views: number; visitors: number }>;
  pages: Array<{ path: string; views: number }>;
  referrers: Array<{ host: string; views: number }>;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;

/** Counting on top of the plugin's tables (`analytics_*`); every statement binds its values. */
export function createAnalytics(
  db: AnalyticsDb,
  options: { now?: () => Date; salt?: DailySalt } = {},
): Analytics {
  const now = options.now ?? (() => new Date());
  const salt = options.salt ?? new DailySalt();

  return {
    async record(hit) {
      const day = dayOf(now());
      // First hit of a new day: the old salt is gone, so yesterday's hashes are useless; drop them.
      if (salt.day !== undefined && salt.day !== day) {
        await db.execute('DELETE FROM analytics_visitors WHERE day < ?', [day]);
      }
      const visitor = hashVisitor(salt.forDay(day), hit.ip, hit.userAgent);

      let path = hit.path;
      let referrer = hit.referrer;
      const known = await db.query(
        'SELECT views FROM analytics_views WHERE day = ? AND path = ? AND referrer = ?',
        [day, path, referrer],
      );
      if (known.length === 0) {
        const [row] = await db.query('SELECT COUNT(*) AS n FROM analytics_views WHERE day = ?', [
          day,
        ]);
        if (num(row?.['n']) >= MAX_ROWS_PER_DAY) {
          path = OTHER_PATH;
          referrer = '';
        }
      }
      await db.execute(
        'INSERT INTO analytics_views (day, path, referrer, views) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (day, path, referrer) DO UPDATE SET views = analytics_views.views + 1',
        [day, path, referrer, 1],
      );

      const seen = await db.query(
        'SELECT visitor FROM analytics_visitors WHERE day = ? AND visitor = ?',
        [day, visitor],
      );
      if (seen.length === 0) {
        await db.execute(
          'INSERT INTO analytics_visitors (day, visitor) VALUES (?, ?) ON CONFLICT (day, visitor) DO NOTHING',
          [day, visitor],
        );
        await db.execute(
          'INSERT INTO analytics_days (day, visitors) VALUES (?, ?) ' +
            'ON CONFLICT (day) DO UPDATE SET visitors = analytics_days.visitors + 1',
          [day, 1],
        );
      }
    },

    async prune(retentionDays) {
      const cutoff = shiftDay(dayOf(now()), readRetentionDays(retentionDays));
      await db.execute('DELETE FROM analytics_views WHERE day < ?', [cutoff]);
      await db.execute('DELETE FROM analytics_days WHERE day < ?', [cutoff]);
      await db.execute('DELETE FROM analytics_visitors WHERE day < ?', [dayOf(now())]);
    },

    async summary(from, to, topLimit = 20) {
      const range = [from, to];
      const views = await db.query(
        'SELECT day, SUM(views) AS views FROM analytics_views WHERE day >= ? AND day <= ? GROUP BY day',
        range,
      );
      const visitors = await db.query(
        'SELECT day, visitors FROM analytics_days WHERE day >= ? AND day <= ?',
        range,
      );
      const pages = await db.query(
        'SELECT path, SUM(views) AS views FROM analytics_views WHERE day >= ? AND day <= ? ' +
          'GROUP BY path ORDER BY SUM(views) DESC, path ASC LIMIT ?',
        [from, to, topLimit],
      );
      const referrers = await db.query(
        'SELECT referrer, SUM(views) AS views FROM analytics_views WHERE day >= ? AND day <= ? AND referrer <> ? ' +
          'GROUP BY referrer ORDER BY SUM(views) DESC, referrer ASC LIMIT ?',
        [from, to, '', topLimit],
      );
      const viewsByDay = new Map(views.map((r) => [String(r['day']), num(r['views'])]));
      const visitorsByDay = new Map(visitors.map((r) => [String(r['day']), num(r['visitors'])]));
      const days: Summary['days'] = [];
      for (let day = from; day <= to; day = shiftDay(day, -1)) {
        days.push({ day, views: viewsByDay.get(day) ?? 0, visitors: visitorsByDay.get(day) ?? 0 });
      }
      return {
        from,
        to,
        totals: {
          views: days.reduce((sum, d) => sum + d.views, 0),
          visitors: days.reduce((sum, d) => sum + d.visitors, 0),
        },
        days,
        pages: pages.map((r) => ({ path: String(r['path']), views: num(r['views']) })),
        referrers: referrers.map((r) => ({ host: String(r['referrer']), views: num(r['views']) })),
      };
    },
  };
}
