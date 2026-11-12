import { BlockEditor } from '@nodepress/editor/react';
import { BLOCK_DOCUMENT_VERSION, type BlockDocument } from '@nodepress/editor';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { STATUS_LABELS } from '../content.js';
import {
  buildPatch,
  canAutosave,
  createContent,
  describeRevision,
  describeSaveError,
  EMPTY_STATE,
  fetchContent,
  fetchRevisions,
  isDirty,
  saveLabel,
  statusChoices,
  toEditState,
  updateContent,
  type ContentItem,
  type EditState,
  type RevisionItem,
} from '../post-edit.js';
import { sessionQuery } from '../session.js';

/** How long the form must sit unchanged before a draft saves itself. */
export const AUTOSAVE_DELAY_MS = 2000;

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const primaryClass =
  'rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'w-full rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const labelClass = 'block text-sm font-medium text-slate-700';

interface Props {
  /** The content type's API name, for example `post` or `page`. */
  type: string;
  /** Singular noun for headings, for example `Post`. */
  noun: string;
}

/** Loads the item named in the URL (or starts an empty one) and shows the edit form. */
export function PostEdit({ type, noun }: Props) {
  const params = useParams({ strict: false }) as { id?: string };
  const id =
    params.id === undefined ? null : /^[0-9]{1,15}$/.test(params.id) ? Number(params.id) : NaN;

  const item = useQuery({
    queryKey: ['content', type, 'item', id],
    queryFn: () => fetchContent(type, id as number),
    enabled: typeof id === 'number' && !Number.isNaN(id),
    // The form keeps its own copy once loaded, so never refetch behind it or reuse a stale one.
    staleTime: Infinity,
    gcTime: 0,
  });

  if (id !== null && Number.isNaN(id)) {
    return <NotFound type={type} noun={noun} />;
  }
  if (id !== null) {
    if (item.isError) {
      return (
        <section>
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
            {describeSaveError(item.error)}
          </p>
          <BackLink type={type} />
        </section>
      );
    }
    if (!item.data) return <p className="text-slate-700">Loading…</p>;
  }
  return <EditForm key={item.data?.id ?? 'new'} type={type} noun={noun} item={item.data ?? null} />;
}

function NotFound({ type, noun }: Props) {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">{noun} not found</h1>
      <BackLink type={type} />
    </section>
  );
}

function BackLink({ type }: { type: string }) {
  return type === 'page' ? (
    <Link to="/pages" className="mt-4 inline-block text-sm text-slate-700 underline">
      Back to Pages
    </Link>
  ) : (
    <Link to="/posts" className="mt-4 inline-block text-sm text-slate-700 underline">
      Back to Posts
    </Link>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface FormProps extends Props {
  /** The saved item, or `null` for a new one. */
  item: ContentItem | null;
}

function EditForm({ type, noun, item }: FormProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const itemId = item?.id ?? null;
  const isNew = itemId === null;

  const [saved, setSaved] = useState<EditState>(() => (item ? toEditState(item) : EMPTY_STATE));
  const [form, setForm] = useState<EditState>(saved);
  // The editor takes its content once; restoring a revision replaces it by changing the key.
  const [editorKey, setEditorKey] = useState(0);
  const [initialDoc, setInitialDoc] = useState<BlockDocument>({
    version: BLOCK_DOCUMENT_VERSION,
    blocks: saved.body,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const dirty = isDirty(form, saved);
  // A ref so the autosave timer and the save callback always see the latest values.
  const latest = useRef({ form, saved });
  latest.current = { form, saved };

  const save = useMutation({
    mutationFn: async (mode: 'manual' | 'auto') => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      const { form: current, saved: base } = latest.current;
      const patch = buildPatch(current, base, { includeStatus: mode === 'manual' });
      if (itemId === null) {
        return { item: await createContent(type, patch, session.csrfToken), sent: patch };
      }
      if (Object.keys(patch).length === 0) return { item: null, sent: patch };
      return { item: await updateContent(type, itemId, patch, session.csrfToken), sent: patch };
    },
    onSuccess: async ({ item: result, sent }) => {
      if (!result) return;
      const next = toEditState(result);
      const sentSlug = sent.slug ?? latest.current.saved.slug;
      setSaved(next);
      // Keep what the person typed while the request ran, but take the slug the server chose
      // when the form still held the one that was sent (or none, so one was generated).
      setForm((current) => (current.slug === sentSlug ? { ...current, slug: next.slug } : current));
      setLastSavedAt(new Date());
      setNotice(null);
      // Refreshes the list screens and this item's revision history.
      await queryClient.invalidateQueries({ queryKey: ['content', type] });
      if (isNew) {
        const to = String(result.id);
        if (type === 'page')
          await navigate({ to: '/pages/$id', params: { id: to }, replace: true });
        else await navigate({ to: '/posts/$id', params: { id: to }, replace: true });
      }
    },
  });

  const { mutate, isPending: isSaving } = save;

  // Drafts save themselves a moment after the last change. The status never autosaves.
  useEffect(() => {
    if (isNew || !canAutosave(saved) || isSaving) return;
    if (Object.keys(buildPatch(form, saved, { includeStatus: false })).length === 0) return;
    const timer = setTimeout(() => mutate('auto'), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [form, saved, isNew, isSaving, mutate]);

  // Warn before leaving the page with edits that are not saved.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const revisions = useQuery({
    queryKey: ['content', type, 'revisions', itemId],
    queryFn: () => fetchRevisions(type, itemId as number),
    enabled: itemId !== null,
  });

  const set = <K extends keyof EditState>(key: K, value: EditState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const restore = (revision: RevisionItem) => {
    const snapshot = revision.snapshot;
    // The title, text, slug and excerpt come back; the status and date stay as they are, so
    // restoring an old version can never publish or unpublish anything by itself.
    setForm((current) => ({
      ...current,
      title: snapshot.title,
      slug: snapshot.slug,
      excerpt: snapshot.excerpt ?? '',
      body: snapshot.body,
    }));
    setInitialDoc({ version: BLOCK_DOCUMENT_VERSION, blocks: snapshot.body });
    setEditorKey((key) => key + 1);
    setNotice('Version restored into the form. Save to keep it.');
  };

  const status = isNew
    ? 'Not saved yet'
    : save.isPending
      ? 'Saving…'
      : dirty
        ? canAutosave(saved)
          ? 'Unsaved changes (drafts save automatically)'
          : 'Unsaved changes'
        : lastSavedAt
          ? `Saved at ${lastSavedAt.toLocaleTimeString()}`
          : 'All changes saved';

  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">
        {isNew ? `Add new ${noun.toLowerCase()}` : `Edit ${noun.toLowerCase()}`}
      </h1>
      <BackLink type={type} />

      <form
        className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate('manual');
        }}
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="edit-title" className={labelClass}>
              Title
            </label>
            <input
              id="edit-title"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              className={`${inputClass} text-lg`}
            />
          </div>
          <div>
            <p className={`${labelClass} mb-1`}>Content</p>
            <BlockEditor
              key={editorKey}
              value={initialDoc}
              onChange={(doc) => set('body', doc.blocks)}
              label="Content"
            />
          </div>
        </div>

        <aside className="space-y-4" aria-label="Item settings">
          <div className="space-y-3 rounded bg-white p-4 shadow">
            <div className="space-y-1">
              <label htmlFor="edit-status" className={labelClass}>
                Status
              </label>
              <select
                id="edit-status"
                value={form.status}
                onChange={(e) => set('status', e.target.value as EditState['status'])}
                className={`${inputClass} bg-white`}
              >
                {statusChoices(saved.status).map((choice) => (
                  <option key={choice} value={choice}>
                    {STATUS_LABELS[choice]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-date" className={labelClass}>
                Publish date
              </label>
              <input
                id="edit-date"
                type="datetime-local"
                value={form.publishedAt}
                onChange={(e) => set('publishedAt', e.target.value)}
                className={inputClass}
              />
              <p className="text-xs text-slate-600">
                Leave empty to use the time of publishing. A future date with the Scheduled status
                publishes automatically.
              </p>
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-slug" className={labelClass}>
                Slug
              </label>
              <input
                id="edit-slug"
                value={form.slug}
                onChange={(e) => set('slug', e.target.value)}
                className={inputClass}
              />
              <p className="text-xs text-slate-600">Leave empty to create it from the title.</p>
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-excerpt" className={labelClass}>
                Excerpt
              </label>
              <textarea
                id="edit-excerpt"
                rows={3}
                value={form.excerpt}
                onChange={(e) => set('excerpt', e.target.value)}
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              className={primaryClass}
              disabled={save.isPending || (!isNew && !dirty)}
            >
              {saveLabel(isNew, form.status)}
            </button>
            <p role="status" className="min-h-5 text-sm text-slate-700">
              {status}
            </p>
            {notice && <p className="text-sm text-slate-700">{notice}</p>}
            {save.isError && (
              <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
                {describeSaveError(save.error)}
              </p>
            )}
          </div>

          {!isNew && (
            <div className="rounded bg-white p-4 shadow">
              <h2 className="text-base font-semibold text-slate-900">Revision history</h2>
              {revisions.isError && (
                <p role="alert" className="mt-2 text-sm text-red-800">
                  {describeSaveError(revisions.error)}
                </p>
              )}
              {revisions.data && revisions.data.length === 0 && (
                <p className="mt-2 text-sm text-slate-700">No saved versions yet.</p>
              )}
              <ol aria-label="Revisions" className="mt-2 space-y-2">
                {(revisions.data ?? []).map((revision, index, all) => (
                  <li key={revision.id} className="text-sm text-slate-800">
                    <p>{describeRevision(revision, index, all.length)}</p>
                    <p className="text-xs text-slate-600">{formatTime(revision.createdAt)}</p>
                    <button
                      type="button"
                      className={`${buttonClass} mt-1`}
                      aria-label={`Restore ${describeRevision(revision, index, all.length)}`}
                      onClick={() => restore(revision)}
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </form>
    </section>
  );
}
