import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import {
  describePanelError,
  diffPanel,
  fetchExtensions,
  fetchPageValues,
  fieldLabel,
  savePanel,
  toPanelDraft,
  type ExtensionPageInfo,
  type PanelDefinition,
  type PanelDraft,
  type PanelField,
} from '../extensions.js';
import { describeError } from '../api.js';
import { sessionQuery } from '../session.js';
import { ReportView } from './ReportView.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full max-w-md rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const labelClass = 'block text-sm font-medium text-slate-700';
const hintClass = 'mt-1 text-xs text-slate-700';

function FieldInput({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: PanelField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const hint = field.description ? `${id}-hint` : undefined;
  if (field.type === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        aria-describedby={hint}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  const text = typeof value === 'string' ? value : '';
  if (field.type === 'select') {
    return (
      <select
        id={id}
        value={text}
        aria-describedby={hint}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      >
        {!field.required && <option value="">(default)</option>}
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'text' && field.multiline) {
    return (
      <textarea
        id={id}
        value={text}
        rows={4}
        maxLength={field.maxLength}
        aria-describedby={hint}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  return (
    <input
      id={id}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={text}
      min={field.min}
      max={field.max}
      step={field.type === 'number' ? (field.integer ? 1 : 'any') : undefined}
      maxLength={field.maxLength}
      aria-describedby={hint}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    />
  );
}

function PanelForm({
  plugin,
  page,
  panel,
  saved,
}: {
  plugin: string;
  page: string;
  panel: PanelDefinition;
  saved: Record<string, unknown> | undefined;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PanelDraft>(() => toPanelDraft(panel.fields, saved));
  const [status, setStatus] = useState('');

  // After a save the form shows what the server stored.
  useEffect(() => setDraft(toPanelDraft(panel.fields, saved)), [panel.fields, saved]);

  const patch = diffPanel(panel.fields, saved, draft);
  const changed = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return savePanel(plugin, page, panel.id, patch, session.csrfToken);
    },
    onMutate: () => setStatus(''),
    onSuccess: (values) => {
      queryClient.setQueryData(['admin-extension-values', plugin, page], (old: unknown) => ({
        ...(old as Record<string, Record<string, unknown>> | undefined),
        [panel.id]: values,
      }));
      setStatus(`${panel.title} saved.`);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) save.mutate();
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-labelledby={`panel-${panel.id}-title`}
      className="mt-4 max-w-2xl space-y-4 bg-white p-4 shadow"
    >
      <h2 id={`panel-${panel.id}-title`} className="text-lg font-semibold text-slate-900">
        {panel.title}
      </h2>
      {panel.description && <p className="text-sm text-slate-700">{panel.description}</p>}
      {panel.fields.map((field) => {
        const id = `ext-${panel.id}-${field.name}`;
        const input = (
          <FieldInput
            id={id}
            field={field}
            value={draft[field.name] ?? ''}
            onChange={(value) => setDraft({ ...draft, [field.name]: value })}
          />
        );
        return (
          <div key={field.name}>
            {field.type === 'boolean' ? (
              <label
                htmlFor={id}
                className="flex items-center gap-2 text-sm font-medium text-slate-700"
              >
                {input}
                {fieldLabel(field)}
              </label>
            ) : (
              <>
                <label htmlFor={id} className={labelClass}>
                  {fieldLabel(field)}
                </label>
                {input}
              </>
            )}
            {field.description && (
              <p id={`${id}-hint`} className={hintClass}>
                {field.description}
              </p>
            )}
          </div>
        );
      })}
      {save.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describePanelError(save.error, panel.fields)}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass} disabled={!changed || save.isPending}>
          Save changes
        </button>
        <p role="status" className="min-h-6 text-sm text-slate-700">
          {status}
        </p>
      </div>
    </form>
  );
}

function PageBody({ page }: { page: ExtensionPageInfo }) {
  // A report-only page has no settings to load.
  const hasPanels = page.panels.length > 0;
  const values = useQuery({
    queryKey: ['admin-extension-values', page.plugin, page.id],
    queryFn: () => fetchPageValues(page.plugin, page.id),
    enabled: hasPanels,
  });
  return (
    <>
      {page.description && <p className="mt-2 text-sm text-slate-700">{page.description}</p>}
      {page.report && <ReportView plugin={page.plugin} report={page.report} />}
      {values.isError && (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(values.error)}
        </p>
      )}
      {values.data &&
        page.panels.map((panel) => (
          <PanelForm
            key={panel.id}
            plugin={page.plugin}
            page={page.id}
            panel={panel}
            saved={values.data[panel.id]}
          />
        ))}
    </>
  );
}

/** A page added by a plugin: its settings panels, drawn from the plugin's description. */
export function ExtensionPage() {
  const params = useParams({ strict: false }) as { plugin?: string; page?: string };
  const extensions = useQuery({
    queryKey: ['admin-extensions'],
    queryFn: fetchExtensions,
    staleTime: 60_000,
  });
  const page = extensions.data?.pages.find(
    (p) => p.plugin === params.plugin && p.id === params.page,
  );
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">{page?.title ?? 'Plugin page'}</h1>
      {extensions.isError && (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(extensions.error)}
        </p>
      )}
      {extensions.data && !page && (
        <p className="mt-2 text-sm text-slate-700">
          This page is not available. The plugin may be turned off, or you may not have permission
          to use it.
        </p>
      )}
      {page && <PageBody key={`${page.plugin}/${page.id}`} page={page} />}
    </section>
  );
}
