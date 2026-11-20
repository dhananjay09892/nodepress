import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { sessionQuery } from '../session.js';
import { defineScreen } from '../screen-types.js';
import { fetchUsers } from '../users.js';
import {
  checkExportFile,
  describeImportError,
  fetchImportLimit,
  importWordPress,
  summarizeReport,
  type WpImportReport,
} from '../wp-import.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full rounded border border-slate-400 px-3 py-1.5 text-slate-900';

function Report({ report }: { report: WpImportReport }) {
  return (
    <section aria-labelledby="import-report" className="space-y-4 rounded bg-white p-4 shadow">
      <h2 id="import-report" className="text-lg font-semibold text-slate-900">
        Import report
      </h2>
      <div role="status" className="space-y-1 text-sm text-slate-900">
        {summarizeReport(report).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {report.skipped.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Skipped items ({report.skipped.length})
          </h3>
          <ul className="list-disc pl-5 text-sm text-slate-900">
            {report.skipped.map((item, index) => (
              <li key={`${index}-${item.title}`}>
                {item.title || '(untitled)'} ({item.type}): {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.redirectsSaved && report.redirectsSaved.skipped.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Redirects not saved ({report.redirectsSaved.skipped.length})
          </h3>
          <ul className="list-disc pl-5 text-sm text-slate-900">
            {report.redirectsSaved.skipped.map((item) => (
              <li key={item.from}>
                {item.from}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Warnings ({report.warnings.length})
          </h3>
          <ul className="list-disc pl-5 text-sm text-slate-900">
            {report.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Import() {
  const queryClient = useQueryClient();
  const limit = useQuery({ queryKey: ['import-limit'], queryFn: fetchImportLimit });
  const users = useQuery({ queryKey: ['users'], queryFn: fetchUsers, retry: false });
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [matchAuthors, setMatchAuthors] = useState(true);
  const [defaultAuthor, setDefaultAuthor] = useState('');
  const [report, setReport] = useState<WpImportReport | null>(null);

  const maxBytes = limit.data?.maxBytes ?? 64 * 1024 * 1024;
  const run = useMutation({
    mutationFn: async () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      if (!file) throw new Error('no file');
      return importWordPress(
        await file.text(),
        { matchAuthors, defaultAuthor: defaultAuthor ? Number(defaultAuthor) : undefined },
        session.csrfToken,
      );
    },
    onMutate: () => setReport(null),
    onSuccess: async (result) => {
      setReport(result);
      // New posts and redirects now exist; lists that show them are out of date.
      await queryClient.invalidateQueries({ queryKey: ['redirects'] });
      await queryClient.invalidateQueries({ queryKey: ['content'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (file && !fileProblem) run.mutate();
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Import</h1>
      <p className="max-w-2xl text-sm text-slate-700">
        Bring posts, pages, categories and tags over from WordPress. In WordPress, open Tools,
        Export, choose All content and download the <code>.xml</code> file. Nothing existing is
        changed: imported items are added next to what you already have, and the old addresses are
        saved as redirects.
      </p>
      {limit.isPending && <p>Loading…</p>}
      {limit.isError && <p role="alert">Could not check the importer.</p>}
      {limit.data === null && <p role="alert">You do not have permission to import.</p>}
      {limit.data && (
        <form
          aria-label="WordPress import"
          onSubmit={onSubmit}
          className="space-y-4 rounded bg-white p-4 shadow"
        >
          <div>
            <label htmlFor="import-file" className="block text-sm font-medium text-slate-700">
              WordPress export file
            </label>
            <input
              id="import-file"
              type="file"
              accept=".xml,text/xml,application/xml"
              disabled={run.isPending}
              aria-describedby={fileProblem ? 'import-file-problem' : undefined}
              onChange={(e) => {
                const chosen = e.target.files?.[0] ?? null;
                setFile(chosen);
                setFileProblem(chosen ? checkExportFile(chosen, maxBytes) : null);
                setReport(null);
              }}
              className="text-sm"
            />
            {fileProblem && (
              <p id="import-file-problem" role="alert" className="mt-1 text-sm text-red-800">
                {fileProblem}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              id="import-match"
              type="checkbox"
              checked={matchAuthors}
              onChange={(e) => setMatchAuthors(e.target.checked)}
            />
            <label htmlFor="import-match" className="text-sm text-slate-900">
              Match authors to existing users by email
            </label>
          </div>
          {users.data && (
            <div className="max-w-xs">
              <label htmlFor="import-author" className="block text-sm font-medium text-slate-700">
                Author for everything else
              </label>
              <select
                id="import-author"
                value={defaultAuthor}
                onChange={(e) => setDefaultAuthor(e.target.value)}
                className={fieldClass}
              >
                <option value="">Me</option>
                {users.data.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} ({user.email})
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="submit"
            className={buttonClass}
            disabled={!file || !!fileProblem || run.isPending}
          >
            {run.isPending ? 'Importing…' : 'Run import'}
          </button>
          {run.isError && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
              {describeImportError(run.error)}
            </p>
          )}
        </form>
      )}
      {report && <Report report={report} />}
    </div>
  );
}

export default defineScreen({
  id: 'import',
  path: '/import',
  label: 'Import',
  order: 50,
  component: Import,
  available: fetchImportLimit,
});
