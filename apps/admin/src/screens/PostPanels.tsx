import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { diffRevision } from '../diff.js';
import { fetchMedia, fetchMediaPage, isImage, previewUrl, type MediaItem } from '../media.js';
import type { EditState, RevisionItem } from '../post-edit.js';
import { describeSaveError } from '../post-edit.js';
import { sessionQuery } from '../session.js';
import {
  createTerm,
  exactTerm,
  fetchTerms,
  orderTermTree,
  tagSuggestions,
  termsById,
  toggleId,
  CATEGORY_TAXONOMY,
  TAG_TAXONOMY,
  type TermItem,
} from '../terms.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'w-full rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const headingClass = 'text-base font-semibold text-slate-900';
const cardClass = 'rounded bg-white p-4 shadow';

/** The terms of a taxonomy; `null` data means the person may not manage categories. */
function useTerms(taxonomy: string) {
  return useQuery({
    queryKey: ['terms', taxonomy],
    queryFn: () => fetchTerms(taxonomy),
    staleTime: 30_000,
  });
}

function useAddTerm(taxonomy: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return createTerm(taxonomy, name, session.csrfToken);
    },
    onSuccess: (term) => {
      queryClient.setQueryData<TermItem[] | null>(['terms', taxonomy], (old) =>
        old && !old.some((t) => t.id === term.id) ? [...old, term] : old,
      );
    },
  });
}

interface IdsProps {
  ids: number[];
  onChange: (ids: number[]) => void;
}

/** A hierarchical checklist of categories. Hidden without `manage_categories`. */
export function CategoriesPanel({ ids, onChange }: IdsProps) {
  const terms = useTerms(CATEGORY_TAXONOMY);
  if (terms.data === null || terms.data === undefined) {
    return terms.isError ? <PanelError error={terms.error} title="Categories" /> : null;
  }
  const rows = orderTermTree(terms.data);
  return (
    <fieldset className={cardClass}>
      <legend className={headingClass}>Categories</legend>
      {rows.length === 0 && <p className="mt-2 text-sm text-slate-700">No categories yet.</p>}
      <ul className="mt-2 space-y-1">
        {rows.map(({ term, depth }) => (
          <li key={term.id} style={{ paddingLeft: `${depth * 1.25}rem` }}>
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={ids.includes(term.id)}
                onChange={() => onChange(toggleId(ids, term.id))}
              />
              {term.name}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Chosen tags as removable chips, with a type-ahead field that can create a tag. */
export function TagsPanel({ ids, onChange }: IdsProps) {
  const terms = useTerms(TAG_TAXONOMY);
  const add = useAddTerm(TAG_TAXONOMY);
  const [query, setQuery] = useState('');
  const listId = useId();
  if (terms.data === null || terms.data === undefined) {
    return terms.isError ? <PanelError error={terms.error} title="Tags" /> : null;
  }
  const all = terms.data;
  const chosen = termsById(all, ids);
  const suggestions = query.trim() === '' ? [] : tagSuggestions(all, ids, query);
  const existing = exactTerm(all, query);
  const canCreate = query.trim() !== '' && !existing;

  const choose = (term: TermItem) => {
    if (!ids.includes(term.id)) onChange([...ids, term.id]);
    setQuery('');
  };
  const submit = async () => {
    if (query.trim() === '') return;
    if (existing) return choose(existing);
    try {
      choose(await add.mutateAsync(query.trim()));
    } catch {
      // The error is shown below from the mutation state.
    }
  };

  return (
    <div className={cardClass}>
      <h2 className={headingClass}>Tags</h2>
      <ul aria-label="Chosen tags" className="mt-2 flex flex-wrap gap-2">
        {chosen.map((term) => (
          <li
            key={term.id}
            className="flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-sm text-slate-900"
          >
            {term.name}
            <button
              type="button"
              aria-label={`Remove tag ${term.name}`}
              className="px-1 text-slate-700 hover:text-slate-900"
              onClick={() => onChange(ids.filter((id) => id !== term.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 space-y-1">
        <label htmlFor={`${listId}-input`} className="block text-sm font-medium text-slate-700">
          Add tag
        </label>
        <input
          id={`${listId}-input`}
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the tag instead of submitting the whole edit form.
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          className={inputClass}
        />
        {(suggestions.length > 0 || canCreate) && (
          <ul aria-label="Tag suggestions" className="space-y-1">
            {suggestions.map((term) => (
              <li key={term.id}>
                <button type="button" className={buttonClass} onClick={() => choose(term)}>
                  {term.name}
                </button>
              </li>
            ))}
            {canCreate && (
              <li>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={add.isPending}
                  onClick={() => void submit()}
                >
                  Create tag “{query.trim()}”
                </button>
              </li>
            )}
          </ul>
        )}
        {add.isError && (
          <p role="alert" className="text-sm text-red-800">
            {describeSaveError(add.error)}
          </p>
        )}
      </div>
    </div>
  );
}

function PanelError({ error, title }: { error: unknown; title: string }) {
  return (
    <div className={cardClass}>
      <h2 className={headingClass}>{title}</h2>
      <p role="alert" className="mt-2 text-sm text-red-800">
        {describeSaveError(error)}
      </p>
    </div>
  );
}

function mediaLabel(item: MediaItem): string {
  return item.alt.trim() === '' ? `Image ${item.id}` : item.alt;
}

/** The featured image: a preview, a picker over the media library, and a remove button. */
export function FeaturedImagePanel({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const current = useQuery({
    queryKey: ['media', 'item', value],
    queryFn: () => fetchMedia(value as number),
    enabled: value !== null,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div className={cardClass}>
      <h2 className={headingClass}>Featured image</h2>
      {value !== null && (
        <figure className="mt-2">
          {current.data ? (
            <img
              src={previewUrl(current.data)}
              alt={current.data.alt}
              className="max-h-40 rounded border border-slate-300"
            />
          ) : (
            <p className="text-sm text-slate-700">
              {current.isError ? `Image ${value} (preview unavailable)` : 'Loading…'}
            </p>
          )}
        </figure>
      )}
      <div className="mt-2 flex gap-2">
        <button type="button" className={buttonClass} onClick={() => setPicking(true)}>
          {value === null ? 'Set featured image' : 'Change featured image'}
        </button>
        {value !== null && (
          <button type="button" className={buttonClass} onClick={() => onChange(null)}>
            Remove featured image
          </button>
        )}
      </div>
      {picking && (
        <MediaPicker
          onPick={(item) => {
            onChange(item.id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** Pages through the media library's images; picking one chooses it. */
function MediaPicker({
  onPick,
  onClose,
}: {
  onPick: (item: MediaItem) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const media = useQuery({
    queryKey: ['media', 'picker', page],
    queryFn: () => fetchMediaPage(page),
  });
  const images = (media.data?.items ?? []).filter(isImage);
  return (
    <section
      role="dialog"
      aria-label="Choose featured image"
      className="mt-3 rounded border border-slate-300 bg-slate-50 p-3"
    >
      {media.isError && (
        <p role="alert" className="text-sm text-red-800">
          {describeSaveError(media.error)}
        </p>
      )}
      {media.isPending && <p className="text-sm text-slate-700">Loading…</p>}
      {media.data && images.length === 0 && (
        <p className="text-sm text-slate-700">No images on this page of the library.</p>
      )}
      <ul className="grid grid-cols-3 gap-2">
        {images.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-label={`Use ${mediaLabel(item)}`}
              className="block w-full rounded border border-slate-300 bg-white p-1 hover:border-slate-900"
              onClick={() => onPick(item)}
            >
              <img src={previewUrl(item)} alt="" className="h-16 w-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!media.data?.hasMore}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
        <button type="button" className={buttonClass} onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}

const DIFF_STYLE = {
  same: 'text-slate-800',
  added: 'bg-green-50 text-green-900',
  removed: 'bg-red-50 text-red-900 line-through',
} as const;
const DIFF_MARK = { same: '  ', added: '+ ', removed: '− ' } as const;
const DIFF_NAME = { same: 'Unchanged', added: 'Added', removed: 'Removed' } as const;

/** Title and text differences between a chosen revision and the form. */
export function RevisionDiffView({
  revision,
  form,
  onClose,
}: {
  revision: RevisionItem;
  form: Pick<EditState, 'title' | 'body'>;
  onClose: () => void;
}) {
  const diff = diffRevision(revision.snapshot, form);
  const lines = (list: typeof diff.text) => (
    <ul className="space-y-0.5 font-mono text-xs">
      {list.map((line, i) => (
        <li key={i} className={`whitespace-pre-wrap px-1 ${DIFF_STYLE[line.kind]}`}>
          <span aria-hidden="true">{DIFF_MARK[line.kind]}</span>
          <span className="sr-only">{DIFF_NAME[line.kind]}: </span>
          {line.text === '' ? '(empty)' : line.text}
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Changes since this version" className="mt-2 rounded bg-slate-50 p-2">
      <p className="text-xs text-slate-700">
        Changes from this version to what is in the form now.
      </p>
      {diff.identical ? (
        <p className="mt-1 text-sm text-slate-800">The title and text are the same.</p>
      ) : (
        <div className="mt-1 space-y-2">
          <div>
            <h3 className="text-xs font-semibold text-slate-700">Title</h3>
            {lines(diff.title)}
          </div>
          <div>
            <h3 className="text-xs font-semibold text-slate-700">Text</h3>
            {diff.text.length === 0 ? (
              <p className="text-xs text-slate-700">(no text)</p>
            ) : (
              lines(diff.text)
            )}
          </div>
        </div>
      )}
      <button type="button" className={`${buttonClass} mt-2`} onClick={onClose}>
        Hide changes
      </button>
    </section>
  );
}
