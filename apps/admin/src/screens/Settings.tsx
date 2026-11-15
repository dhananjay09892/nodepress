import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { sessionQuery } from '../session.js';
import {
  MAX_POSTS_PER_PAGE,
  PERMALINK_PRESETS,
  SECTION_LABELS,
  describeSettingsError,
  diffSettings,
  fetchPublishedPages,
  fetchSettings,
  presetFor,
  saveSettings,
  timezoneNames,
  toDraft,
  type SettingsDraft,
  type SettingsSection,
  type SettingsValues,
} from '../settings.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full max-w-md rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const labelClass = 'block text-sm font-medium text-slate-700';
const hintClass = 'mt-1 text-xs text-slate-700';

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className={hintClass}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Check({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <p id={`${id}-hint`} className={hintClass}>
        {hint}
      </p>
    </div>
  );
}

function SectionForm({
  section,
  saved,
  draft,
  setDraft,
}: {
  section: SettingsSection;
  saved: SettingsValues;
  draft: SettingsDraft;
  setDraft: (next: SettingsDraft) => void;
}) {
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft({ ...draft, [key]: value });
  const pages = useQuery({
    queryKey: ['settings-pages'],
    queryFn: fetchPublishedPages,
    enabled: section === 'reading',
  });
  const [custom, setCustom] = useState(presetFor(saved.permalink_structure) === 'custom');

  if (section === 'general') {
    return (
      <>
        <Field id="set-title" label="Site title">
          <input
            id="set-title"
            value={draft.site_title}
            maxLength={200}
            onChange={(e) => set('site_title', e.target.value)}
            className={fieldClass}
          />
        </Field>
        <Field id="set-tagline" label="Tagline" hint="A few words about the site.">
          <input
            id="set-tagline"
            value={draft.tagline}
            maxLength={300}
            aria-describedby="set-tagline-hint"
            onChange={(e) => set('tagline', e.target.value)}
            className={fieldClass}
          />
        </Field>
        <Field id="set-timezone" label="Time zone">
          <select
            id="set-timezone"
            value={draft.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            className={fieldClass}
          >
            {timezoneNames(saved.timezone).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      </>
    );
  }

  if (section === 'reading') {
    const choices = pages.data ?? [];
    const current = draft.front_page_id;
    const known = current === '' || choices.some((p) => String(p.id) === current);
    return (
      <>
        <Field
          id="set-front"
          label="Front page"
          hint="Show a page at the front of the site, or your latest posts."
        >
          <select
            id="set-front"
            value={current}
            aria-describedby="set-front-hint"
            onChange={(e) => set('front_page_id', e.target.value)}
            className={fieldClass}
          >
            <option value="">Your latest posts</option>
            {!known && <option value={current}>Page {current}</option>}
            {choices.map((page) => (
              <option key={page.id} value={String(page.id)}>
                {page.title}
              </option>
            ))}
          </select>
        </Field>
        <Field id="set-per-page" label="Posts per page">
          <input
            id="set-per-page"
            inputMode="numeric"
            value={draft.posts_per_page}
            maxLength={3}
            aria-describedby="set-per-page-hint"
            onChange={(e) => set('posts_per_page', e.target.value)}
            className="w-24 rounded border border-slate-400 px-3 py-1.5 text-slate-900"
          />
        </Field>
        <p id="set-per-page-hint" className={hintClass}>
          From 1 to {MAX_POSTS_PER_PAGE}.
        </p>
        <Check
          id="set-discourage"
          label="Discourage search engines from indexing this site"
          hint="It is up to search engines to honour this request."
          checked={draft.discourage_search_engines}
          onChange={(value) => set('discourage_search_engines', value)}
        />
        <Check
          id="set-public-read"
          label="Let anyone read published content through the API"
          hint="For headless sites. Drafts and private items are never shown."
          checked={draft.api_public_read}
          onChange={(value) => set('api_public_read', value)}
        />
      </>
    );
  }

  const preset = custom ? 'custom' : presetFor(draft.permalink_structure);
  return (
    <>
      <Field
        id="set-permalink-preset"
        label="Post URL structure"
        hint="Pages always live at /their-slug."
      >
        <select
          id="set-permalink-preset"
          value={preset}
          aria-describedby="set-permalink-preset-hint"
          onChange={(e) => {
            if (e.target.value === 'custom') setCustom(true);
            else {
              setCustom(false);
              set('permalink_structure', e.target.value);
            }
          }}
          className={fieldClass}
        >
          {PERMALINK_PRESETS.map((p) => (
            <option key={p.pattern} value={p.pattern}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </Field>
      <Field
        id="set-permalink"
        label="Pattern"
        hint="Tokens: :slug, :id, :year, :month, :day. Use exactly one of :slug or :id."
      >
        <input
          id="set-permalink"
          value={draft.permalink_structure}
          maxLength={200}
          spellCheck={false}
          readOnly={!custom}
          aria-describedby="set-permalink-hint"
          onChange={(e) => set('permalink_structure', e.target.value)}
          className={`${fieldClass} font-mono`}
        />
      </Field>
    </>
  );
}

function SettingsForm({ section, saved }: { section: SettingsSection; saved: SettingsValues }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(saved));
  const [status, setStatus] = useState('');

  // After a save (or when another screen's save refreshed the values) the form shows what is stored.
  useEffect(() => setDraft(toDraft(saved)), [saved]);

  const patch = diffSettings(section, saved, draft);
  const changed = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return saveSettings(patch, session.csrfToken);
    },
    onSuccess: (values) => {
      queryClient.setQueryData(['settings'], values);
      setStatus(`${SECTION_LABELS[section]} settings saved.`);
    },
    onMutate: () => setStatus(''),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) save.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="mt-4 max-w-2xl space-y-4 bg-white p-4 shadow">
      <SectionForm section={section} saved={saved} draft={draft} setDraft={setDraft} />
      {save.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeSettingsError(save.error)}
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

const subLinkClass = 'rounded px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-200';
const subActive = { className: `${subLinkClass} bg-slate-200 font-medium text-slate-900` };

export function Settings({ section }: { section: SettingsSection }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
      <nav aria-label="Settings sections" className="mt-4 flex gap-1">
        <Link
          to="/settings"
          activeOptions={{ exact: true }}
          className={subLinkClass}
          activeProps={subActive}
        >
          General
        </Link>
        <Link to="/settings/reading" className={subLinkClass} activeProps={subActive}>
          Reading
        </Link>
        <Link to="/settings/permalinks" className={subLinkClass} activeProps={subActive}>
          Permalinks
        </Link>
      </nav>
      <h2 className="mt-4 text-lg font-semibold text-slate-900">{SECTION_LABELS[section]}</h2>
      {settings.isError && (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeSettingsError(settings.error)}
        </p>
      )}
      {settings.data && <SettingsForm key={section} section={section} saved={settings.data} />}
    </section>
  );
}
