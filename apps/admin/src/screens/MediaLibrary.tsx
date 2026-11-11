import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { describeError } from '../api.js';
import {
  ACCEPTED_TYPES,
  deleteMedia,
  describeUpload,
  fetchMediaPage,
  formatBytes,
  isImage,
  MAX_ALT_LENGTH,
  previewUrl,
  updateAlt,
  uploadFiles,
  type MediaItem,
} from '../media.js';
import { sessionQuery } from '../session.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

type View = 'grid' | 'list';

function label(item: MediaItem): string {
  return item.alt !== '' ? item.alt : (item.url.split('/').pop() ?? `File ${item.id}`);
}

function Thumb({ item, className }: { item: MediaItem; className: string }) {
  if (isImage(item)) {
    return <img src={previewUrl(item)} alt={item.alt} loading="lazy" className={className} />;
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} flex items-center justify-center bg-slate-200 text-xs font-semibold text-slate-700`}
    >
      PDF
    </span>
  );
}

function Details({
  item,
  onDeleted,
  onMessage,
}: {
  item: MediaItem;
  onDeleted: () => void;
  onMessage: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [alt, setAlt] = useState(item.alt);
  const [confirming, setConfirming] = useState(false);

  // Switching to another file resets the form.
  useEffect(() => {
    setAlt(item.alt);
    setConfirming(false);
  }, [item.id, item.alt]);

  const csrf = () => {
    const session = queryClient.getQueryData(sessionQuery.queryKey);
    if (!session) throw new Error('signed out');
    return session.csrfToken;
  };

  const save = useMutation({
    mutationFn: () => updateAlt(item.id, alt.trim(), csrf()),
    onSuccess: async () => {
      onMessage('Alt text saved.');
      await queryClient.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (error) => onMessage(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: () => deleteMedia(item.id, csrf()),
    onSuccess: async () => {
      onDeleted();
      onMessage('File deleted.');
      await queryClient.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (error) => {
      setConfirming(false);
      onMessage(describeError(error));
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <aside aria-label="File details" className="w-full space-y-3 bg-white p-4 shadow lg:w-80">
      <h2 className="text-lg font-semibold text-slate-900">File details</h2>
      {isImage(item) ? (
        <img src={item.variants.medium ?? item.url} alt={item.alt} className="max-h-56 w-auto" />
      ) : (
        <Thumb item={item} className="h-24 w-24" />
      )}
      <dl className="text-sm text-slate-800">
        <dt className="sr-only">File name</dt>
        <dd className="break-all font-medium">{item.url.split('/').pop()}</dd>
        <dt className="sr-only">Details</dt>
        <dd>
          {item.mime} · {formatBytes(item.size)}
          {item.width !== null && item.height !== null ? ` · ${item.width}×${item.height}` : ''}
        </dd>
      </dl>
      <form onSubmit={onSubmit} className="space-y-2">
        <label htmlFor="media-alt" className="block text-sm font-medium text-slate-700">
          Alt text
        </label>
        <textarea
          id="media-alt"
          rows={3}
          maxLength={MAX_ALT_LENGTH}
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          className="w-full rounded border border-slate-400 px-3 py-1.5 text-slate-900"
        />
        <button
          type="submit"
          className={buttonClass}
          disabled={save.isPending || alt.trim() === item.alt}
        >
          Save alt text
        </button>
      </form>
      <div className="border-t border-slate-200 pt-3">
        {confirming ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-50"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Confirm delete
            </button>
            <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className={buttonClass} onClick={() => setConfirming(true)}>
            Delete permanently
          </button>
        )}
      </div>
    </aside>
  );
}

export function MediaLibrary() {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>('grid');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const list = useQuery({
    queryKey: ['media', page],
    queryFn: () => fetchMediaPage(page),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return uploadFiles(files, session.csrfToken);
    },
    onSuccess: async (result) => {
      setMessage(describeUpload(result));
      setPage(0);
      const newest = result.uploaded.at(-1);
      if (newest) setSelectedId(newest.id);
      await queryClient.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (error) => setMessage(describeError(error)),
  });

  const start = (files: FileList | null) => {
    const picked = files ? Array.from(files) : [];
    if (picked.length > 0) {
      setMessage(null);
      upload.mutate(picked);
    }
    if (input.current) input.current.value = '';
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    start(event.dataTransfer.files);
  };

  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Media</h1>

      <div
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-4 flex flex-wrap items-center gap-3 rounded border-2 border-dashed px-4 py-6 ${
          dragging ? 'border-slate-900 bg-slate-100' : 'border-slate-400 bg-white'
        }`}
      >
        <p className="text-sm text-slate-800">Drop files here, or</p>
        <label htmlFor="media-upload" className={`${buttonClass} cursor-pointer`}>
          Upload files
        </label>
        <input
          ref={input}
          id="media-upload"
          type="file"
          multiple
          accept={ACCEPTED_TYPES}
          className="sr-only"
          onChange={(e) => start(e.target.files)}
        />
        <span className="text-xs text-slate-700">Images (JPEG, PNG, GIF, WebP) and PDFs.</span>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div role="group" aria-label="View" className="flex gap-2">
          {(['grid', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={`${buttonClass} ${view === v ? 'font-semibold ring-2 ring-slate-900' : ''}`}
              onClick={() => setView(v)}
            >
              {v === 'grid' ? 'Grid' : 'List'}
            </button>
          ))}
        </div>
        <p role="status" className="min-h-6 text-sm text-slate-700">
          {upload.isPending ? 'Uploading…' : (message ?? '')}
        </p>
      </div>

      {list.isError && (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(list.error)}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          {!list.isPending && items.length === 0 && (
            <p className="rounded bg-white px-3 py-6 text-center text-slate-700 shadow">
              No files yet.
            </p>
          )}

          {view === 'grid' ? (
            <ul aria-label="Media files" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-label={`Select ${label(item)}`}
                    aria-pressed={item.id === selectedId}
                    onClick={() => setSelectedId(item.id)}
                    className={`block w-full overflow-hidden rounded bg-white shadow ${
                      item.id === selectedId ? 'ring-2 ring-slate-900' : ''
                    }`}
                  >
                    <Thumb item={item} className="aspect-square w-full object-cover" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <table className="w-full border-collapse bg-white text-left text-sm shadow">
              <caption className="sr-only">Media files</caption>
              <thead>
                <tr className="border-b border-slate-300 text-slate-700">
                  <th scope="col" className="w-16 px-3 py-2">
                    Preview
                  </th>
                  <th scope="col" className="px-3 py-2">
                    File
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Size
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className={`border-b border-slate-200 ${
                      item.id === selectedId ? 'bg-slate-100' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <Thumb item={item} className="h-10 w-10 object-cover" />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        aria-label={`Select ${label(item)}`}
                        aria-pressed={item.id === selectedId}
                        onClick={() => setSelectedId(item.id)}
                        className="font-medium text-slate-900 underline"
                      >
                        {label(item)}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-slate-800">{item.mime}</td>
                    <td className="px-3 py-2 text-slate-800">{formatBytes(item.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <nav
            aria-label="Pagination"
            className="mt-4 flex items-center gap-3 text-sm text-slate-700"
          >
            <button
              type="button"
              className={buttonClass}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              type="button"
              className={buttonClass}
              disabled={!list.data?.hasMore}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </nav>
        </div>

        {selected && (
          <Details item={selected} onDeleted={() => setSelectedId(null)} onMessage={setMessage} />
        )}
      </div>
    </section>
  );
}
