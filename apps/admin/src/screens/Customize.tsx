import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import {
  changedValues,
  contrastWarning,
  describeThemeSettingsError,
  fetchThemeSettings,
  previewUrl,
  resetValues,
  saveThemeSettings,
  type ThemeSettingInfo,
  type ThemeSettingsOverview,
} from '../customizer.js';
import { sessionQuery } from '../session.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full max-w-sm rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const labelClass = 'block text-sm font-medium text-slate-700';

function SettingField(props: {
  setting: ThemeSettingInfo;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { setting, value, onChange } = props;
  const id = `setting-${setting.key}`;
  const text = typeof value === 'string' ? value : '';
  let input;
  if (setting.type === 'select') {
    input = (
      <select
        id={id}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      >
        {(setting.options ?? []).map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  } else if (setting.type === 'color') {
    input = (
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(text) ? text : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-14 rounded border border-slate-400"
        />
        <code className="text-sm text-slate-800">{text}</code>
      </div>
    );
  } else if (setting.type === 'boolean') {
    input = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else if (setting.type === 'number') {
    input = (
      <input
        id={id}
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className={fieldClass}
      />
    );
  } else {
    // `string` and `image` settings are text: an image is the address of a picture.
    input = (
      <input
        id={id}
        value={text}
        placeholder={setting.type === 'image' ? '/media/logo.png or https://…' : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  const warning = setting.type === 'color' ? contrastWarning(text) : null;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {setting.label}
      </label>
      {input}
      {warning && (
        <p id={`${id}-warning`} className="mt-1 max-w-sm text-xs text-amber-900">
          {warning}
        </p>
      )}
    </div>
  );
}

function Editor({ overview }: { overview: ThemeSettingsOverview }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, unknown>>(overview.values);
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>(overview.values);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const valuesKey = JSON.stringify(overview.values);

  // After a save or reset the form shows what is now in effect.
  useEffect(() => {
    const values = JSON.parse(valuesKey) as Record<string, unknown>;
    setDraft(values);
    setPreviewValues(values);
  }, [valuesKey]);

  // The preview frame follows the form a moment after the last change.
  useEffect(() => {
    const timer = setTimeout(() => setPreviewValues(draft), 250);
    return () => clearTimeout(timer);
  }, [draft]);

  const patch = changedValues(overview.values, draft);
  const dirty = Object.keys(patch).length > 0;

  const done = (text: string) => async (next: ThemeSettingsOverview) => {
    queryClient.setQueryData(['theme-settings'], next);
    setMessage({ kind: 'ok', text });
  };
  const save = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return saveThemeSettings(patch, session.csrfToken);
    },
    onSuccess: done('Customizations saved.'),
    onError: (error) => setMessage({ kind: 'error', text: describeThemeSettingsError(error) }),
  });
  const reset = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return saveThemeSettings(resetValues(overview.saved), session.csrfToken);
    },
    onSuccess: done('Back to the theme defaults.'),
    onError: (error) => setMessage({ kind: 'error', text: describeThemeSettingsError(error) }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    save.mutate();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <form
        onSubmit={onSubmit}
        aria-label="Theme settings"
        className="space-y-4 rounded border border-slate-300 bg-white p-4"
      >
        <p className="text-sm text-slate-700">
          Theme: <strong>{overview.theme.title}</strong>
        </p>
        {overview.settings.length === 0 && (
          <p className="text-sm text-slate-700">This theme has no settings to customize.</p>
        )}
        {overview.settings.map((setting) => (
          <SettingField
            key={setting.key}
            setting={setting}
            value={draft[setting.key]}
            onChange={(value) => setDraft({ ...draft, [setting.key]: value })}
          />
        ))}
        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={message.kind === 'error' ? 'text-sm text-red-800' : 'text-sm text-green-800'}
          >
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={buttonClass} disabled={!dirty || save.isPending}>
            Save changes
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={Object.keys(overview.saved).length === 0 || reset.isPending}
            onClick={() => {
              setMessage(null);
              reset.mutate();
            }}
          >
            Reset to defaults
          </button>
        </div>
      </form>
      <div>
        <h2 className="mb-2 text-base font-semibold text-slate-900">Live preview</h2>
        <iframe
          title="Live preview of the site"
          src={previewUrl(previewValues)}
          className="h-[36rem] w-full rounded border border-slate-300 bg-white"
        />
      </div>
    </div>
  );
}

export function Customize() {
  const overview = useQuery({ queryKey: ['theme-settings'], queryFn: fetchThemeSettings });
  let body;
  if (overview.isPending) body = <p className="text-slate-700">Loading…</p>;
  else if (overview.isError) {
    body = (
      <p role="alert" className="text-red-800">
        The theme settings could not be loaded. Is a theme active?
      </p>
    );
  } else if (overview.data === null) {
    body = (
      <p role="alert" className="text-slate-700">
        You do not have permission to customize the theme.
      </p>
    );
  } else body = <Editor overview={overview.data} />;
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Customize</h1>
      {body}
    </section>
  );
}
