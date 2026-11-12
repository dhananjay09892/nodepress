import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { describeError } from '../api.js';
import {
  applyBulk,
  describeBulk,
  fetchContentList,
  pageCount,
  STATUS_LABELS,
  type BulkAction,
  type ContentStatus,
  type ListParams,
} from '../content.js';
import { sessionQuery } from '../session.js';

interface Props {
  /** The content type's API name, for example `post` or `page`. */
  type: string;
  /** Heading and nouns for this screen, for example `Posts`. */
  title: string;
}

const STATUS_FILTERS: { value: ListParams['status']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'published', label: STATUS_LABELS.published },
  { value: 'draft', label: STATUS_LABELS.draft },
  { value: 'scheduled', label: STATUS_LABELS.scheduled },
  { value: 'private', label: STATUS_LABELS.private },
  { value: 'trash', label: STATUS_LABELS.trash },
];

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const linkButtonClass = `${buttonClass} inline-block`;

/** Links are written out per type so the router can check each route and its parameters. */
function AddLink({ type, title }: Props) {
  const label = `Add new ${title.replace(/s$/, '').toLowerCase()}`;
  return type === 'page' ? (
    <Link to="/pages/new" className={linkButtonClass}>
      {label}
    </Link>
  ) : (
    <Link to="/posts/new" className={linkButtonClass}>
      {label}
    </Link>
  );
}

function EditLink({ type, id, children }: { type: string; id: number; children: string }) {
  const className = 'underline hover:text-slate-600';
  return type === 'page' ? (
    <Link to="/pages/$id" params={{ id: String(id) }} className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/posts/$id" params={{ id: String(id) }} className={className}>
      {children}
    </Link>
  );
}

export function ContentList({ type, title }: Props) {
  const queryClient = useQueryClient();
  const [searchDraft, setSearchDraft] = useState('');
  const [params, setParams] = useState<ListParams>({ search: '', status: 'all', page: 0 });
  const [selected, setSelected] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['content', type, params],
    queryFn: () => fetchContentList(type, params),
    placeholderData: keepPreviousData,
  });

  const bulk = useMutation({
    mutationFn: async (action: BulkAction) => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      const result = await applyBulk(type, selected, action, session.csrfToken);
      return { action, result };
    },
    onSuccess: async ({ action, result }) => {
      setMessage(describeBulk(action, result));
      setSelected(result.failed.map((f) => f.id));
      await queryClient.invalidateQueries({ queryKey: ['content', type] });
    },
    onError: (error) => setMessage(describeError(error)),
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = pageCount(total);
  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.id));
  const inTrash = params.status === 'trash';

  const change = (next: Partial<ListParams>) => {
    setParams((current) => ({ ...current, page: 0, ...next }));
    setSelected([]);
    setMessage(null);
  };

  const goToPage = (page: number) => {
    setParams((current) => ({ ...current, page }));
    setSelected([]);
  };

  const toggle = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    change({ search: searchDraft });
  };

  return (
    <section>
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <AddLink type={type} title={title} />
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <form onSubmit={onSearch} role="search" className="flex items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="content-search" className="block text-sm font-medium text-slate-700">
              Search
            </label>
            <input
              id="content-search"
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              className="rounded border border-slate-400 px-3 py-1.5 text-slate-900"
            />
          </div>
          <button type="submit" className={buttonClass}>
            Search
          </button>
        </form>

        <div className="space-y-1">
          <label htmlFor="content-status" className="block text-sm font-medium text-slate-700">
            Status
          </label>
          <select
            id="content-status"
            value={params.status}
            onChange={(e) => change({ status: e.target.value as ContentStatus | 'all' })}
            className="rounded border border-slate-400 bg-white px-3 py-1.5 text-slate-900"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2" role="group" aria-label="Bulk actions">
          <button
            type="button"
            className={buttonClass}
            disabled={selected.length === 0 || bulk.isPending}
            onClick={() => bulk.mutate('publish')}
          >
            {inTrash ? 'Restore and publish' : 'Publish'}
          </button>
          {!inTrash && (
            <button
              type="button"
              className={buttonClass}
              disabled={selected.length === 0 || bulk.isPending}
              onClick={() => bulk.mutate('trash')}
            >
              Move to trash
            </button>
          )}
        </div>
      </div>

      <p role="status" className="mt-3 min-h-6 text-sm text-slate-700">
        {message ?? (selected.length > 0 ? `${selected.length} selected` : '')}
      </p>

      {list.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(list.error)}
        </p>
      )}

      <table className="mt-2 w-full border-collapse bg-white text-left text-sm shadow">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="border-b border-slate-300 text-slate-700">
            <th scope="col" className="w-10 px-3 py-2">
              <input
                type="checkbox"
                aria-label={`Select all ${title.toLowerCase()} on this page`}
                checked={allSelected}
                disabled={items.length === 0}
                onChange={() => setSelected(allSelected ? [] : items.map((item) => item.id))}
              />
            </th>
            <th scope="col" className="px-3 py-2">
              Title
            </th>
            <th scope="col" className="px-3 py-2">
              Status
            </th>
            <th scope="col" className="px-3 py-2">
              Last updated
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-slate-200">
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${item.title}`}
                  checked={selected.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
              </td>
              <td className="px-3 py-2 font-medium text-slate-900">
                <EditLink type={type} id={item.id}>
                  {item.title === '' ? '(no title)' : item.title}
                </EditLink>
              </td>
              <td className="px-3 py-2 text-slate-800">{STATUS_LABELS[item.status]}</td>
              <td className="px-3 py-2 text-slate-800">{formatDate(item.updatedAt)}</td>
            </tr>
          ))}
          {!list.isPending && items.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-slate-700">
                Nothing found.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <nav aria-label="Pagination" className="mt-4 flex items-center gap-3 text-sm text-slate-700">
        <button
          type="button"
          className={buttonClass}
          disabled={params.page === 0}
          onClick={() => goToPage(params.page - 1)}
        >
          Previous
        </button>
        <span>
          Page {params.page + 1} of {pages} ({total} {total === 1 ? 'item' : 'items'})
        </span>
        <button
          type="button"
          className={buttonClass}
          disabled={params.page + 1 >= pages}
          onClick={() => goToPage(params.page + 1)}
        >
          Next
        </button>
      </nav>
    </section>
  );
}
