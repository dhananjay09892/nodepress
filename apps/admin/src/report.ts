import { ApiError, request, toError } from './api.js';

/** Column of a report table, as a plugin declared it. */
export interface ReportColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

/** A report a plugin page declared (see `AdminReportDefinition` in `@nodepress/core`). */
export interface ReportDefinition {
  route: string;
  defaultDays?: number;
  maxDays?: number;
  totals?: { key: string; label: string }[];
  chart?: {
    title: string;
    rows: string;
    x: string;
    series: { key: string; label: string }[];
  };
  tables?: { rows: string; title: string; columns: ReportColumn[] }[];
}

export type ReportData = Record<string, unknown>;

export interface DateRange {
  from: string;
  to: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
export const DEFAULT_REPORT_DAYS = 30;
export const DEFAULT_MAX_REPORT_DAYS = 366;

function dayNumber(day: string): number | undefined {
  const match = DAY.exec(day);
  if (!match) return undefined;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(time);
  // Reject 2026-02-31 and friends: the date must round-trip.
  return date.toISOString().slice(0, 10) === day ? time / DAY_MS : undefined;
}

/** Today as `YYYY-MM-DD` in UTC, the day boundary the plugins count with. */
export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day `days` before (negative: after) `day`. */
export function shiftDay(day: string, days: number): string {
  const n = dayNumber(day);
  if (n === undefined) throw new Error(`Not a day: ${day}`);
  return toDay(new Date((n - days) * DAY_MS));
}

/** The last `days` days up to and including today. */
export function lastDays(now: Date, days: number): DateRange {
  const to = toDay(now);
  return { from: shiftDay(to, Math.max(1, Math.floor(days)) - 1), to };
}

/** How many days a range covers, both ends included; `undefined` for an invalid range. */
export function rangeLength(range: DateRange): number | undefined {
  const from = dayNumber(range.from);
  const to = dayNumber(range.to);
  if (from === undefined || to === undefined || from > to) return undefined;
  return to - from + 1;
}

/** A sentence for the first problem with a range, or `null` when it can be used. */
export function checkRange(
  range: DateRange,
  maxDays = DEFAULT_MAX_REPORT_DAYS,
  now = new Date(),
): string | null {
  if (dayNumber(range.from) === undefined) return 'Enter a start date.';
  if (dayNumber(range.to) === undefined) return 'Enter an end date.';
  const length = rangeLength(range);
  if (length === undefined) return 'The start date must not be after the end date.';
  if (range.to > toDay(now)) return 'The end date cannot be in the future.';
  if (length > maxDays) return `Choose at most ${maxDays} days.`;
  return null;
}

export function reportUrl(plugin: string, route: string, range: DateRange): string {
  const query = new URLSearchParams({ from: range.from, to: range.to });
  return `/api/v1/plugins/${encodeURIComponent(plugin)}${route}?${query.toString()}`;
}

export async function fetchReport(
  plugin: string,
  report: Pick<ReportDefinition, 'route'>,
  range: DateRange,
): Promise<ReportData> {
  const res = await request(reportUrl(plugin, report.route, range));
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = (await res.clone().json()) as { message?: unknown };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON; keep the status text below.
    }
    const error = await toError(res);
    throw message ? new ReportError(error.status, error.code, message) : error;
  }
  return (await res.json()) as ReportData;
}

export class ReportError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly detail: string,
  ) {
    super(status, code);
  }
}

/** A sentence a person can act on, for a report that did not load. */
export function describeReportError(error: unknown): string {
  if (error instanceof ReportError) return error.detail;
  if (error instanceof ApiError) {
    if (error.status === 403) return 'You do not have permission to see this report.';
    if (error.status === 401) return 'Your session has ended. Sign in again.';
    if (error.status === 404) return 'This report is not available. The plugin may be turned off.';
    return 'The report could not be loaded. Please try again.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/** The array a table or chart reads, or an empty list when the answer lacks it. */
export function rowsOf(data: ReportData | undefined, key: string): Record<string, unknown>[] {
  const value = data?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row),
  );
}

/** A number from `data.totals[key]`, or `undefined` when it is not there. */
export function totalOf(data: ReportData | undefined, key: string): number | undefined {
  const totals = data?.['totals'];
  if (typeof totals !== 'object' || totals === null) return undefined;
  const value = (totals as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A cell as text: numbers with thousands separators when the column is numeric. */
export function formatCell(value: unknown, numeric = false): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return numeric ? value.toLocaleString('en-US') : String(value);
  }
  if (typeof value === 'string') return value;
  return '';
}

export interface Bar {
  /** The series key, so the caller can pick a color and a label. */
  series: string;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  max: number;
  /** One group of bars per row, in row order. */
  groups: { label: string; bars: Bar[] }[];
}

/**
 * Bar positions for a chart of `rows`, grouped by row with one bar per series. Heights scale to
 * the biggest value (at least 1, so an empty chart is flat); a value of 0 gets no height. No
 * dependency: the screen draws these as SVG rects, and the same numbers are shown in a table.
 */
export function layoutChart(
  rows: readonly Record<string, unknown>[],
  x: string,
  seriesKeys: readonly string[],
  size = { width: 640, height: 200 },
): ChartLayout {
  const values = rows.map((row) =>
    seriesKeys.map((key) => {
      const v = row[key];
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    }),
  );
  const max = Math.max(1, ...values.flat());
  const slot = rows.length === 0 ? size.width : size.width / rows.length;
  const gap = Math.min(4, slot * 0.2);
  const barWidth = Math.max(1, (slot - gap) / Math.max(1, seriesKeys.length));
  const groups = rows.map((row, i) => ({
    label: typeof row[x] === 'string' ? (row[x] as string) : '',
    bars: seriesKeys.map((series, s): Bar => {
      const value = values[i]![s]!;
      const height = (value / max) * size.height;
      return {
        series,
        value,
        x: i * slot + gap / 2 + s * barWidth,
        y: size.height - height,
        width: barWidth,
        height,
      };
    }),
  }));
  return { width: size.width, height: size.height, max, groups };
}
