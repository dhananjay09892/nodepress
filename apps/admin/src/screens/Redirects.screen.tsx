import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { sessionQuery } from '../session.js';
import {
  createRedirect,
  deleteRedirect,
  describeRedirectError,
  diffRedirect,
  fetchRedirects,
  importRedirectsCsv,
  MAX_CSV_BYTES,
  redirectsToCsv,
  RedirectApiError,
  updateRedirect,
  type CsvImportReport,
  type RedirectRule,
} from '../redirects.js';
import { defineScreen } from '../screen-types.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full rounded border border-slate-400 px-3 py-1.5 text-slate-900';

function csrf(queryClient: ReturnType<typeof useQueryClient>): string {
  const session = queryClient.getQueryData(sessionQuery.queryKey);
  if (!session) throw new Error('signed out');
  return session.csrfToken;
}

/** The server's message when it names a field, shown next to that field. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof RedirectApiError && error.status === 400 && error.field === field
    ? describeRedirectError(error)
    : undefined;
}

function RuleRow({ rule }: { rule: RedirectRule }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(rule.from);
  const [to, setTo] = useState(rule.to);
  const [status, setStatus] = useState<number>(rule.status);

  const save = useMutation({
    mutationFn: () => updateRedirect(rule.id, diffRedirect(rule, { from, to, status }), csrf(queryClient)),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['redirects'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteRedirect(rule.id, csrf(queryClient)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['redirects'] }),
  });

  if (!editing) {
    return (
      <tr className="border-t border-slate-200">
        <td className="px-3 py-2 font-mono text-sm">{rule.from}</td>
        <td className="px-3 py-2 font-mono text-sm">{rule.to}</td>
        <td className="px-3 py-2 text-sm">{rule.status}</td>
        <td className="space-x-2 px-3 py-2 text-right">
          <button
            type="button"
            className={buttonClass}
            aria-label={`Edit redirect from ${rule.from}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className={buttonClass}
            aria-label={`Delete redirect from ${rule.from}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete
          </button>
          {remove.isError && (
            <span role="alert" className="block text-xs text-red-800">
              {describeRedirectError(remove.error)}
            </span>
          )}
        </td>
      </tr>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (Object.keys(diffRedirect(rule, { from, to, status })).length === 0) setEditing(false);
    else save.mutate();
  };
  const fromError = fieldError(save.error, 'from');
  const toError = fieldError(save.error, 'to');
  return (
    <tr className="border-t border-slate-200 bg-slate-50">
      <td colSpan={4} className="px-3 py-3">
        <form aria-label={`Edit redirect from ${rule.from}`} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor={`edit-from-${rule.id}`} className="block text-sm font-medium text-slate-700">
              From
            </label>
            <input
              id={`edit-from-${rule.id}`}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={fromError ? true : undefined}
              className={fieldClass}
            />
            {fromError && <p role="alert" className="mt-1 text-xs text-red-800">{fromError}</p>}
          </div>
          <div>
            <label htmlFor={`edit-to-${rule.id}`} className="block text-sm font-medium text-slate-700">
              To
            </label>
            <input
              id={`edit-to-${rule.id}`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={toError ? true : undefined}
              className={fieldClass}
            />
            {toError && <p role="alert" className="mt-1 text-xs text-red-800">{toError}</p>}
          </div>
          <div>
            <label htmlFor={`edit-status-${rule.id}`} className="block text-sm font-medium text-slate-700">
              Type
            </label>
            <select
              id={`edit-status-${rule.id}`}
              value={status}
              onChange={(e) => setStatus(Number(e.target.value))}
              className={fieldClass}
            >
              <option value={301}>301 permanent</option>
              <option value={302}>302 temporary</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClass} disabled={save.isPending}>
              Save
            </button>
            <button type="button" className={buttonClass} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {save.isError && !fromError && !toError && (
            <p role="alert" className="text-sm text-red-800 sm:col-span-4">
              {describeRedirectError(save.error)}
            </p>
          )}
        </form>
      </td>
    </tr>
  );
}

function AddForm() {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState(301);
  const add = useMutation({
    mutationFn: () => createRedirect({ from: from.trim(), to: to.trim(), status }, csrf(queryClient)),
    onSuccess: async () => {
      setFrom('');
      setTo('');
      setStatus(301);
      await queryClient.invalidateQueries({ queryKey: ['redirects'] });
    },
  });
  const fromError = fieldError(add.error, 'from');
  const toError = fieldError(add.error, 'to');
  return (
    <form
      aria-label="Add redirect"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
      className="grid gap-3 rounded bg-white p-4 shadow sm:grid-cols-4"
    >
      <div>
        <label htmlFor="redirect-from" className="block text-sm font-medium text-slate-700">
          From
        </label>
        <input
          id="redirect-from"
          value={from}
          placeholder="/old-page or /blog/*"
          onChange={(e) => setFrom(e.target.value)}
          aria-invalid={fromError ? true : undefined}
          className={fieldClass}
        />
        {fromError && <p role="alert" className="mt-1 text-xs text-red-800">{fromError}</p>}
      </div>
      <div>
        <label htmlFor="redirect-to" className="block text-sm font-medium text-slate-700">
          To
        </label>
        <input
          id="redirect-to"
          value={to}
          placeholder="/new-page or https://…"
          onChange={(e) => setTo(e.target.value)}
          aria-invalid={toError ? true : undefined}
          className={fieldClass}
        />
        {toError && <p role="alert" className="mt-1 text-xs text-red-800">{toError}</p>}
      </div>
      <div>
        <label htmlFor="redirect-status" className="block text-sm font-medium text-slate-700">
          Type
        </label>
        <select
          id="redirect-status"
          value={status}
          onChange={(e) => setStatus(Number(e.target.value))}
          className={fieldClass}
        >
          <option value={301}>301 permanent</option>
          <option value={302}>302 temporary</option>
        </select>
      </div>
      <div className="flex items-end">
        <button type="submit" className={buttonClass} disabled={add.isPending}>
          Add redirect
        </button>
      </div>
      {add.isError && !fromError && !toError && (
        <p role="alert" className="text-sm text-red-800 sm:col-span-4">
          {describeRedirectError(add.error)}
        </p>
      )}
    </form>
  );
}

function ImportPanel({ rules }: { rules: RedirectRule[] }) {
  const queryClient = useQueryClient();
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_CSV_BYTES) throw new RedirectApiError(413, 'payload_too_large');
      return importRedirectsCsv(await file.text(), csrf(queryClient));
    },
    onMutate: () => {
      setReport(null);
      setProblem(null);
    },
    onSuccess: async (result) => {
      setReport(result);
      await queryClient.invalidateQueries({ queryKey: ['redirects'] });
    },
    onError: (error) => setProblem(describeRedirectError(error)),
  });

  const download = () => {
    const url = URL.createObjectURL(new Blob([redirectsToCsv(rules)], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'redirects.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby="redirects-csv" className="space-y-3 rounded bg-white p-4 shadow">
      <h2 id="redirects-csv" className="text-lg font-semibold text-slate-900">
        Import and export
      </h2>
      <p className="text-sm text-slate-700">
        A CSV file with the columns <code>from,to,status</code> (the header row is optional). Rows with an
        old path that already has a rule replace that rule.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="redirects-file" className="block text-sm font-medium text-slate-700">
            CSV file
          </label>
          <input
            id="redirects-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            disabled={run.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) run.mutate(file);
              e.target.value = '';
            }}
            className="text-sm"
          />
        </div>
        <button type="button" className={buttonClass} disabled={rules.length === 0} onClick={download}>
          Download CSV
        </button>
      </div>
      {problem && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {problem}
        </p>
      )}
      {report && (
        <div role="status" className="space-y-2 text-sm text-slate-900">
          <p>
            Imported: {report.created} created, {report.updated} updated, {report.errors.length} refused.
          </p>
          {report.errors.length > 0 && (
            <ul className="list-disc pl-5 text-red-800">
              {report.errors.map((e) => (
                <li key={`${e.line}-${e.message}`}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Redirects() {
  const rules = useQuery({ queryKey: ['redirects'], queryFn: fetchRedirects });
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Redirects</h1>
      <p className="max-w-2xl text-sm text-slate-700">
        Send visitors from an old address to a new one. A path ending in <code>*</code> matches any ending, and
        the same <code>*</code> in the target is replaced by what it matched. A real page at the same address
        always wins.
      </p>
      <AddForm />
      {rules.isPending && <p>Loading…</p>}
      {rules.isError && <p role="alert">Could not load redirects.</p>}
      {rules.data === null && <p role="alert">You do not have permission to manage redirects.</p>}
      {rules.data && (
        <>
          {rules.data.length === 0 ? (
            <p className="text-sm text-slate-700">No redirects yet.</p>
          ) : (
            <div className="overflow-x-auto rounded bg-white shadow">
              <table className="w-full text-left">
                <caption className="sr-only">Redirect rules</caption>
                <thead className="text-xs uppercase text-slate-700">
                  <tr>
                    <th scope="col" className="px-3 py-2">From</th>
                    <th scope="col" className="px-3 py-2">To</th>
                    <th scope="col" className="px-3 py-2">Type</th>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.data.map((rule) => (
                    <RuleRow key={rule.id} rule={rule} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ImportPanel rules={rules.data} />
        </>
      )}
    </div>
  );
}

export default defineScreen({
  id: 'redirects',
  path: '/redirects',
  label: 'Redirects',
  order: 40,
  component: Redirects,
  available: fetchRedirects,
});
