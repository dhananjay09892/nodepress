import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { sessionQuery } from '../session.js';
import {
  describePluginError,
  fetchPlugins,
  permissionLabel,
  setPluginEnabled,
  statusLabel,
  uploadPlugin,
  type PluginPackage,
  type PluginsOverview,
} from '../plugins.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const primaryClass =
  'rounded border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50';
const cardClass = 'rounded border border-slate-300 bg-white p-4';

function useCsrf(): string {
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData(sessionQuery.queryKey);
  if (!session) throw new Error('signed out');
  return session.csrfToken;
}

function PermissionList({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return <p className="text-sm text-slate-700">This plugin asks for no permissions.</p>;
  }
  return (
    <ul className="list-disc pl-5 text-sm text-slate-800">
      {permissions.map((permission) => (
        <li key={permission}>{permissionLabel(permission)}</li>
      ))}
    </ul>
  );
}

function PluginCard(props: {
  plugin: PluginPackage;
  busy: boolean;
  onToggle: (plugin: PluginPackage, enabled: boolean) => void;
}) {
  const { plugin, busy, onToggle } = props;
  const [confirming, setConfirming] = useState(false);
  const headingId = `plugin-${plugin.name}`;
  return (
    <li className={cardClass}>
      <article aria-labelledby={headingId}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={headingId} className="text-lg font-semibold text-slate-900">
            {plugin.title}{' '}
            <span className="text-sm font-normal text-slate-600">{plugin.version}</span>
          </h2>
          <p className="text-sm font-medium text-slate-800">{statusLabel(plugin)}</p>
        </div>
        {plugin.description ? (
          <p className="mt-1 text-sm text-slate-700">{plugin.description}</p>
        ) : null}
        {plugin.error ? (
          <p role="alert" className="mt-2 text-sm text-red-800">
            {plugin.error}
          </p>
        ) : null}
        <div className="mt-3">
          <h3 className="text-sm font-medium text-slate-700">Permissions it declares</h3>
          <PermissionList permissions={plugin.permissions} />
          <p className="mt-1 text-xs text-slate-600">
            Permissions are a promise by the plugin&apos;s author, not a sandbox. Only enable
            plugins you trust.
          </p>
        </div>
        <div className="mt-3">
          {plugin.enabled ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => onToggle(plugin, false)}
            >
              Disable {plugin.title}
            </button>
          ) : confirming ? (
            <div
              role="group"
              aria-label={`Enable ${plugin.title}?`}
              className="rounded border border-slate-400 p-3"
            >
              <p className="text-sm text-slate-900">Enable {plugin.title}? It will be able to:</p>
              <PermissionList permissions={plugin.permissions} />
              {plugin.hasMigrations ? (
                <p className="mt-1 text-sm text-slate-800">
                  It also changes the database when the site restarts.
                </p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={primaryClass}
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    onToggle(plugin, true);
                  }}
                >
                  Enable plugin
                </button>
                <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Enable {plugin.title}
            </button>
          )}
        </div>
      </article>
    </li>
  );
}

export function Plugins() {
  const queryClient = useQueryClient();
  const csrf = useCsrf();
  const overview = useQuery({ queryKey: ['plugins'], queryFn: fetchPlugins });
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const publish = (next: PluginsOverview): void => {
    queryClient.setQueryData(['plugins'], next);
  };

  const upload = useMutation({
    mutationFn: (zip: File) => uploadPlugin(zip, csrf),
    onSuccess: (next) => {
      publish(next);
      setProblem(null);
      setMessage('Plugin uploaded. It is off until you enable it.');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    },
    onError: (error) => {
      setMessage(null);
      setProblem(describePluginError(error));
    },
  });

  const toggle = useMutation({
    mutationFn: (input: { plugin: PluginPackage; enabled: boolean }) =>
      setPluginEnabled(input.plugin.name, input.enabled, csrf),
    onSuccess: (next, input) => {
      publish(next);
      setProblem(null);
      setMessage(`${input.plugin.title} ${input.enabled ? 'enabled' : 'disabled'}.`);
    },
    onError: (error) => {
      setMessage(null);
      setProblem(describePluginError(error));
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!file) {
      setMessage(null);
      setProblem('Choose a .zip file first.');
      return;
    }
    upload.mutate(file);
  };

  const data = overview.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Plugins</h1>

      {data?.restartRequired ? (
        <p
          role="note"
          className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Restart the site for the changes below to take effect. Plugins load when it starts.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-red-800">
          {problem}
        </p>
      ) : null}

      <form onSubmit={submit} aria-label="Upload a plugin" className={cardClass}>
        <h2 className="text-lg font-semibold text-slate-900">Upload a plugin</h2>
        <p className="mt-1 text-sm text-slate-700">
          A .zip with a <code>plugin.json</code> at its top level. The plugin stays off until you
          enable it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium text-slate-700" htmlFor="plugin-file">
            Plugin package (.zip)
          </label>
          <input
            id="plugin-file"
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          <button type="submit" className={buttonClass} disabled={upload.isPending}>
            Upload plugin
          </button>
        </div>
      </form>

      {overview.isPending ? <p>Loading plugins…</p> : null}
      {overview.isError ? <p role="alert">Could not load plugins.</p> : null}
      {data && data.plugins.length === 0 ? (
        <p className="text-slate-700">No plugins are installed yet.</p>
      ) : null}
      {data && data.plugins.length > 0 ? (
        <ul className="space-y-4" aria-label="Installed plugins">
          {data.plugins.map((plugin) => (
            <PluginCard
              key={plugin.name}
              plugin={plugin}
              busy={toggle.isPending}
              onToggle={(p, enabled) => toggle.mutate({ plugin: p, enabled })}
            />
          ))}
        </ul>
      ) : null}
      {data && data.broken.length > 0 ? (
        <section aria-label="Plugins that could not be read" className={cardClass}>
          <h2 className="text-lg font-semibold text-slate-900">Could not be read</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-slate-800">
            {data.broken.map((item) => (
              <li key={item.folder}>
                <code>{item.folder}</code>: {item.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
