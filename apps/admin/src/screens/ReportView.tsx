import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  DEFAULT_MAX_REPORT_DAYS,
  DEFAULT_REPORT_DAYS,
  checkRange,
  describeReportError,
  fetchReport,
  formatCell,
  lastDays,
  layoutChart,
  rowsOf,
  totalOf,
  type DateRange,
  type ReportColumn,
  type ReportData,
  type ReportDefinition,
} from '../report.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const PRESETS = [7, 30, 90];
// Dark enough for 3:1 against white (non-text contrast) and told apart without color by the legend.
const SERIES_COLORS = ['#1d4ed8', '#047857', '#b45309'];

function DataTable({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Record<string, unknown>[];
  columns: ReportColumn[];
}) {
  return (
    <div className="max-h-96 overflow-auto rounded bg-white shadow">
      <table className="w-full text-left text-sm text-slate-900">
        <caption className="sr-only">{title}</caption>
        <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-700">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-3 py-2 ${column.numeric ? 'text-right' : ''}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-3 text-slate-700">
                Nothing in this period.
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-slate-200">
              {columns.map((column, c) =>
                c === 0 ? (
                  <th key={column.key} scope="row" className="px-3 py-2 font-normal">
                    {formatCell(row[column.key], column.numeric)}
                  </th>
                ) : (
                  <td
                    key={column.key}
                    className={`px-3 py-2 ${column.numeric ? 'text-right' : ''}`}
                  >
                    {formatCell(row[column.key], column.numeric)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chart({
  chart,
  data,
}: {
  chart: NonNullable<ReportDefinition['chart']>;
  data: ReportData;
}) {
  const rows = rowsOf(data, chart.rows);
  const labels = new Map(chart.series.map((s) => [s.key, s.label]));
  const layout = layoutChart(
    rows,
    chart.x,
    chart.series.map((s) => s.key),
  );
  const color = (key: string) =>
    SERIES_COLORS[chart.series.findIndex((s) => s.key === key) % SERIES_COLORS.length];
  const summary = `${chart.title}: ${rows.length} days, highest value ${layout.max.toLocaleString('en-US')}. The same numbers are in the table below.`;
  const columns: ReportColumn[] = [
    { key: chart.x, label: 'Day' },
    ...chart.series.map((s) => ({ key: s.key, label: s.label, numeric: true })),
  ];
  return (
    <section aria-labelledby="report-chart-title" className="space-y-2">
      <h2 id="report-chart-title" className="text-lg font-semibold text-slate-900">
        {chart.title}
      </h2>
      <figure className="rounded bg-white p-4 shadow">
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          className="h-48 w-full"
        >
          <line
            x1="0"
            x2={layout.width}
            y1={layout.height - 0.5}
            y2={layout.height - 0.5}
            stroke="#475569"
            strokeWidth="1"
          />
          {layout.groups.map((group) =>
            group.bars.map((bar) => (
              <rect
                key={`${group.label}-${bar.series}`}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                fill={color(bar.series)}
              >
                <title>{`${group.label}: ${labels.get(bar.series)} ${bar.value.toLocaleString('en-US')}`}</title>
              </rect>
            )),
          )}
        </svg>
        <figcaption className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-700">
          {chart.series.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
                <rect width="12" height="12" rx="2" fill={color(s.key)} />
              </svg>
              {s.label}
            </span>
          ))}
          <span>Highest: {layout.max.toLocaleString('en-US')}</span>
        </figcaption>
      </figure>
      <details>
        <summary className="cursor-pointer text-sm text-slate-900 underline">
          Show {chart.title.toLowerCase()} as a table
        </summary>
        <div className="mt-2">
          <DataTable title={chart.title} rows={rows} columns={columns} />
        </div>
      </details>
    </section>
  );
}

/** A report a plugin page declared: date range, totals, a chart with a table, and tables. */
export function ReportView({ plugin, report }: { plugin: string; report: ReportDefinition }) {
  const maxDays = report.maxDays ?? DEFAULT_MAX_REPORT_DAYS;
  const [initial] = useState(() => lastDays(new Date(), report.defaultDays ?? DEFAULT_REPORT_DAYS));
  const [applied, setApplied] = useState<DateRange>(initial);
  const [draft, setDraft] = useState<DateRange>(initial);
  const problem = checkRange(draft, maxDays);

  const query = useQuery({
    queryKey: ['plugin-report', plugin, report.route, applied.from, applied.to],
    queryFn: () => fetchReport(plugin, report, applied),
  });
  const data = query.data;

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (!problem) setApplied(draft);
  };
  const preset = (days: number) => {
    const range = lastDays(new Date(), days);
    setDraft(range);
    setApplied(range);
  };

  return (
    <div className="mt-4 space-y-6">
      <form
        onSubmit={apply}
        aria-label="Date range"
        className="flex flex-wrap items-end gap-3 rounded bg-white p-4 shadow"
      >
        <div>
          <label htmlFor="report-from" className="block text-sm font-medium text-slate-700">
            From
          </label>
          <input
            id="report-from"
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            aria-describedby={problem ? 'report-range-problem' : undefined}
            aria-invalid={problem ? true : undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="report-to" className="block text-sm font-medium text-slate-700">
            To
          </label>
          <input
            id="report-to"
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            aria-describedby={problem ? 'report-range-problem' : undefined}
            aria-invalid={problem ? true : undefined}
            className={inputClass}
          />
        </div>
        <button type="submit" className={buttonClass} disabled={problem !== null}>
          Show
        </button>
        <div role="group" aria-label="Quick ranges" className="flex gap-2">
          {PRESETS.filter((days) => days <= maxDays).map((days) => (
            <button key={days} type="button" className={buttonClass} onClick={() => preset(days)}>
              Last {days} days
            </button>
          ))}
        </div>
        {problem && (
          <p id="report-range-problem" role="alert" className="w-full text-sm text-red-800">
            {problem}
          </p>
        )}
      </form>

      <div role="status" aria-live="polite" className="text-sm text-slate-700">
        {query.isFetching ? 'Loading…' : `Showing ${applied.from} to ${applied.to}.`}
      </div>
      {query.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeReportError(query.error)}
        </p>
      )}

      {data && (
        <>
          {report.totals && (
            <dl className="flex flex-wrap gap-4">
              {report.totals.map((total) => (
                <div key={total.key} className="min-w-40 rounded bg-white p-4 shadow">
                  <dt className="text-sm text-slate-700">{total.label}</dt>
                  <dd className="text-2xl font-semibold text-slate-900">
                    {(totalOf(data, total.key) ?? 0).toLocaleString('en-US')}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {report.chart && <Chart chart={report.chart} data={data} />}
          {report.tables?.map((table) => (
            <section key={table.rows} aria-labelledby={`report-table-${table.rows}`}>
              <h2
                id={`report-table-${table.rows}`}
                className="mb-2 text-lg font-semibold text-slate-900"
              >
                {table.title}
              </h2>
              <DataTable
                title={table.title}
                rows={rowsOf(data, table.rows)}
                columns={table.columns}
              />
            </section>
          ))}
        </>
      )}
    </div>
  );
}
