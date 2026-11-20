import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  checkBackupFile,
  describeBackupError,
  fetchBackupLimit,
  importBackup,
  summarizeBackup,
  type BackupSummary,
} from '../backup.js';
import { defineScreen } from '../screen-types.js';
import { sessionQuery } from '../session.js';

const buttonClass =
  'inline-block rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

function Result({ summary }: { summary: BackupSummary }) {
  return (
    <section aria-labelledby="backup-result" className="space-y-4 rounded bg-white p-4 shadow">
      <h2 id="backup-result" className="text-lg font-semibold text-slate-900">
        Restore result
      </h2>
      <div role="status" className="space-y-1 text-sm text-slate-900">
        {summarizeBackup(summary).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {summary.skipped.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Skipped items ({summary.skipped.length})
          </h3>
          <ul className="list-disc pl-5 text-sm text-slate-900">
            {summary.skipped.map((item, index) => (
              <li key={`${index}-${item.id}`}>
                {item.title || '(untitled)'}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.warnings.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Warnings ({summary.warnings.length})
          </h3>
          <ul className="list-disc pl-5 text-sm text-slate-900">
            {summary.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Backup() {
  const queryClient = useQueryClient();
  const limit = useQuery({ queryKey: ['backup-limit'], queryFn: fetchBackupLimit });
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [summary, setSummary] = useState<BackupSummary | null>(null);

  const maxBytes = limit.data?.maxBytes ?? 256 * 1024 * 1024;
  const run = useMutation({
    mutationFn: async () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      if (!file) throw new Error('no file');
      return importBackup(await file.text(), session.csrfToken);
    },
    onMutate: () => setSummary(null),
    onSuccess: async (result) => {
      setSummary(result);
      await queryClient.invalidateQueries({ queryKey: ['content'] });
      await queryClient.invalidateQueries({ queryKey: ['redirects'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (file && !fileProblem) run.mutate();
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Backup</h1>
      {limit.isPending && <p>Loading…</p>}
      {limit.isError && <p role="alert">Could not check the backup feature.</p>}
      {limit.data === null && <p role="alert">You do not have permission to use backups.</p>}
      {limit.data && (
        <>
          <section aria-labelledby="backup-export" className="space-y-3 rounded bg-white p-4 shadow">
            <h2 id="backup-export" className="text-lg font-semibold text-slate-900">
              Download a backup
            </h2>
            <p className="max-w-2xl text-sm text-slate-700">
              One file with all posts and pages (drafts and trash too), their custom fields,
              categories and tags, the site settings, menus, widgets and redirects. It has no
              users, passwords or secrets, and no uploaded media files yet.
            </p>
            <a href="/api/v1/backup/export" download className={buttonClass}>
              Download backup
            </a>
          </section>
          <form
            aria-label="Restore a backup"
            onSubmit={onSubmit}
            className="space-y-4 rounded bg-white p-4 shadow"
          >
            <h2 className="text-lg font-semibold text-slate-900">Restore a backup</h2>
            <p className="max-w-2xl text-sm text-slate-700">
              Choose a file made by NodePress. Nothing existing is changed or deleted: content is
              added next to what you have, and menus, widgets and settings that are already in use
              are left as they are.
            </p>
            <div>
              <label htmlFor="backup-file" className="block text-sm font-medium text-slate-700">
                Backup file
              </label>
              <input
                id="backup-file"
                type="file"
                accept=".json,application/json"
                disabled={run.isPending}
                aria-describedby={fileProblem ? 'backup-file-problem' : undefined}
                onChange={(e) => {
                  const chosen = e.target.files?.[0] ?? null;
                  setFile(chosen);
                  setFileProblem(chosen ? checkBackupFile(chosen, maxBytes) : null);
                  setSummary(null);
                }}
                className="text-sm"
              />
              {fileProblem && (
                <p id="backup-file-problem" role="alert" className="mt-1 text-sm text-red-800">
                  {fileProblem}
                </p>
              )}
            </div>
            <button
              type="submit"
              className={buttonClass}
              disabled={!file || !!fileProblem || run.isPending}
            >
              {run.isPending ? 'Restoring…' : 'Restore backup'}
            </button>
            {run.isError && (
              <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
                {describeBackupError(run.error)}
              </p>
            )}
          </form>
        </>
      )}
      {summary && <Result summary={summary} />}
    </div>
  );
}

export default defineScreen({
  id: 'backup',
  path: '/backup',
  label: 'Backup',
  order: 60,
  component: Backup,
  available: fetchBackupLimit,
});
