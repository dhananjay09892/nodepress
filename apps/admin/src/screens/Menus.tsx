import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { sessionQuery } from '../session.js';
import {
  MAX_MENU_DEPTH,
  addItem,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  firstItemProblem,
  flattenItems,
  indentItem,
  linkProblem,
  moveItem,
  newItem,
  outdentItem,
  removeItem,
  sameItems,
  updateItem,
  type ItemPath,
  type MenuItem,
} from '../menu-tree.js';
import {
  createMenu,
  deleteMenu,
  describeMenuError,
  diffLocations,
  fetchMenuLocations,
  fetchMenus,
  saveMenuLocations,
  updateMenu,
  type MenuRecord,
} from '../menus.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const smallButtonClass =
  'rounded border border-slate-400 bg-white px-2 py-1 text-xs text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const labelClass = 'block text-sm font-medium text-slate-700';
const cardClass = 'rounded border border-slate-300 bg-white p-4';

const pathKey = (path: ItemPath) => path.join('.');

function useCsrf(): string {
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData(sessionQuery.queryKey);
  if (!session) throw new Error('signed out');
  return session.csrfToken;
}

function ItemRow(props: {
  items: MenuItem[];
  path: ItemPath;
  depth: number;
  item: MenuItem;
  onChange: (items: MenuItem[]) => void;
}) {
  const { items, path, depth, item, onChange } = props;
  const name = item.label || 'link';
  return (
    <li
      style={{ marginLeft: `${(depth - 1) * 1.5}rem` }}
      className="rounded border border-slate-300 bg-slate-50 p-3"
      data-path={pathKey(path)}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={labelClass} htmlFor={`label-${pathKey(path)}`}>
            Label <span className="sr-only">of {name}</span>
          </label>
          <input
            id={`label-${pathKey(path)}`}
            value={item.label}
            maxLength={100}
            onChange={(e) => onChange(updateItem(items, path, { label: e.target.value }))}
            className={`${fieldClass} w-44`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`url-${pathKey(path)}`}>
            Address <span className="sr-only">of {name}</span>
          </label>
          <input
            id={`url-${pathKey(path)}`}
            value={item.url}
            onChange={(e) => onChange(updateItem(items, path, { url: e.target.value }))}
            className={`${fieldClass} w-56`}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={item.target === '_blank'}
            onChange={(e) => onChange(updateItem(items, path, { newTab: e.target.checked }))}
          />
          Open in a new tab <span className="sr-only">for {name}</span>
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Arrange ${name}`}>
        <button
          type="button"
          className={smallButtonClass}
          disabled={!canMoveUp(path)}
          onClick={() => onChange(moveItem(items, path, 'up'))}
          aria-label={`Move ${name} up`}
        >
          Move up
        </button>
        <button
          type="button"
          className={smallButtonClass}
          disabled={!canMoveDown(items, path)}
          onClick={() => onChange(moveItem(items, path, 'down'))}
          aria-label={`Move ${name} down`}
        >
          Move down
        </button>
        <button
          type="button"
          className={smallButtonClass}
          disabled={!canIndent(items, path)}
          onClick={() => onChange(indentItem(items, path))}
          aria-label={`Indent ${name} under the link above`}
        >
          Indent
        </button>
        <button
          type="button"
          className={smallButtonClass}
          disabled={!canOutdent(path)}
          onClick={() => onChange(outdentItem(items, path))}
          aria-label={`Outdent ${name}`}
        >
          Outdent
        </button>
        <button
          type="button"
          className={smallButtonClass}
          onClick={() => onChange(removeItem(items, path))}
          aria-label={`Remove ${name}`}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function MenuEditor({ menu }: { menu: MenuRecord }) {
  const queryClient = useQueryClient();
  const csrf = useCsrf();
  const [name, setName] = useState(menu.name);
  const [items, setItems] = useState<MenuItem[]>(menu.items);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newTab, setNewTab] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Show the saved menu again after a save or when another menu is picked.
  useEffect(() => {
    setName(menu.name);
    setItems(menu.items);
    setConfirmDelete(false);
    setMessage(null);
  }, [menu]);

  const dirty = name.trim() !== menu.name || !sameItems(items, menu.items);
  const rows = flattenItems(items);

  const save = useMutation({
    mutationFn: () => updateMenu(menu.id, { name: name.trim(), items }, csrf),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['menus'] });
      setMessage({ kind: 'ok', text: 'Menu saved.' });
    },
    onError: (error) => setMessage({ kind: 'error', text: describeMenuError(error) }),
  });

  const remove = useMutation({
    mutationFn: () => deleteMenu(menu.id, csrf),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['menus'] });
      await queryClient.invalidateQueries({ queryKey: ['menu-locations'] });
    },
    onError: (error) => setMessage({ kind: 'error', text: describeMenuError(error) }),
  });

  function onSave(event: FormEvent) {
    event.preventDefault();
    const problem = firstItemProblem(items);
    if (problem) {
      setMessage({ kind: 'error', text: problem });
      return;
    }
    setMessage(null);
    save.mutate();
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    const problem = linkProblem(newLabel, newUrl);
    if (problem) {
      setLinkError(problem);
      return;
    }
    setLinkError(null);
    setItems(addItem(items, newItem(newLabel, newUrl, newTab)));
    setNewLabel('');
    setNewUrl('');
    setNewTab(false);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSave} className={`${cardClass} space-y-4`} aria-label="Edit menu">
        <div>
          <label className={labelClass} htmlFor="menu-name">
            Menu name
          </label>
          <input
            id="menu-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className={`${fieldClass} w-full max-w-sm`}
          />
        </div>

        <div>
          <h2 className="text-base font-semibold text-slate-900">Links</h2>
          <p className="text-xs text-slate-700">
            Use Indent and Outdent to nest links up to {MAX_MENU_DEPTH} levels deep.
          </p>
          {rows.length === 0 ? (
            <p className="mt-2 text-sm text-slate-700">This menu has no links yet.</p>
          ) : (
            <ul className="mt-2 space-y-2" aria-label="Menu links">
              {rows.map(({ path, depth, item }) => (
                <ItemRow
                  key={pathKey(path)}
                  items={items}
                  path={path}
                  depth={depth}
                  item={item}
                  onChange={setItems}
                />
              ))}
            </ul>
          )}
        </div>

        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={message.kind === 'error' ? 'text-sm text-red-800' : 'text-sm text-green-800'}
          >
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonClass} disabled={!dirty || save.isPending}>
            Save menu
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-2 text-sm text-slate-800">
              Delete “{menu.name}” and its links?
              <button
                type="button"
                className={buttonClass}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Yes, delete menu
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirmDelete(false)}>
                Keep menu
              </button>
            </span>
          ) : (
            <button type="button" className={buttonClass} onClick={() => setConfirmDelete(true)}>
              Delete menu
            </button>
          )}
        </div>
      </form>

      <form onSubmit={onAdd} className={`${cardClass} space-y-3`} aria-label="Add a link">
        <h2 className="text-base font-semibold text-slate-900">Add a link</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelClass} htmlFor="new-link-label">
              Link label
            </label>
            <input
              id="new-link-label"
              value={newLabel}
              maxLength={100}
              onChange={(e) => setNewLabel(e.target.value)}
              className={`${fieldClass} w-44`}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="new-link-url">
              Link address
            </label>
            <input
              id="new-link-url"
              value={newUrl}
              placeholder="/about or https://…"
              onChange={(e) => setNewUrl(e.target.value)}
              className={`${fieldClass} w-56`}
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" checked={newTab} onChange={(e) => setNewTab(e.target.checked)} />
            Open in a new tab
          </label>
          <button type="submit" className={buttonClass}>
            Add link
          </button>
        </div>
        {linkError && (
          <p role="alert" className="text-sm text-red-800">
            {linkError}
          </p>
        )}
      </form>
    </div>
  );
}

function LocationsPanel({ menus }: { menus: MenuRecord[] }) {
  const queryClient = useQueryClient();
  const csrf = useCsrf();
  const locations = useQuery({ queryKey: ['menu-locations'], queryFn: fetchMenuLocations });
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!locations.data) return;
    const next: Record<string, number | null> = {};
    for (const name of Object.keys(locations.data.locations)) {
      const id = locations.data.assigned[name];
      next[name] = id !== undefined && menus.some((m) => m.id === id) ? id : null;
    }
    setDraft(next);
  }, [locations.data, menus]);

  const save = useMutation({
    mutationFn: (patch: Record<string, number | null>) => saveMenuLocations(patch, csrf),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['menu-locations'] });
      setMessage({ kind: 'ok', text: 'Locations saved.' });
    },
    onError: (error) => setMessage({ kind: 'error', text: describeMenuError(error) }),
  });

  if (!locations.data) return null;
  const entries = Object.entries(locations.data.locations);
  const patch = diffLocations(locations.data.assigned, draft);
  return (
    <form
      className={`${cardClass} space-y-3`}
      aria-label="Menu locations"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        save.mutate(patch);
      }}
    >
      <h2 className="text-base font-semibold text-slate-900">Theme locations</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-700">The active theme has no menu locations.</p>
      ) : (
        <>
          {entries.map(([name, label]) => (
            <div key={name}>
              <label className={labelClass} htmlFor={`loc-${name}`}>
                {label}
              </label>
              <select
                id={`loc-${name}`}
                value={draft[name] ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [name]: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
                className={`${fieldClass} w-full max-w-sm`}
              >
                <option value="">None</option>
                {menus.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {message && (
            <p
              role={message.kind === 'error' ? 'alert' : 'status'}
              className={
                message.kind === 'error' ? 'text-sm text-red-800' : 'text-sm text-green-800'
              }
            >
              {message.text}
            </p>
          )}
          <button
            type="submit"
            className={buttonClass}
            disabled={Object.keys(patch).length === 0 || save.isPending}
          >
            Save locations
          </button>
        </>
      )}
    </form>
  );
}

export function Menus() {
  const queryClient = useQueryClient();
  const csrf = useCsrf();
  const menus = useQuery({ queryKey: ['menus'], queryFn: fetchMenus });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const list = menus.data ?? [];
  const selected = list.find((m) => m.id === selectedId) ?? list[0];

  const create = useMutation({
    mutationFn: (name: string) => createMenu(name, csrf),
    onSuccess: async (menu) => {
      await queryClient.invalidateQueries({ queryKey: ['menus'] });
      setSelectedId(menu.id);
      setNewName('');
      setCreateError(null);
    },
    onError: (error) => setCreateError(describeMenuError(error)),
  });

  if (menus.isPending) return <p className="text-slate-700">Loading menus…</p>;
  if (menus.isError) {
    return (
      <p role="alert" className="text-red-800">
        Menus could not be loaded.
      </p>
    );
  }
  if (menus.data === null) {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">Menus</h1>
        <p role="alert" className="mt-2 text-slate-700">
          You do not have permission to edit menus.
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Menus</h1>

      <div className={`${cardClass} flex flex-wrap items-end gap-6`}>
        {list.length > 0 && (
          <div>
            <label className={labelClass} htmlFor="menu-picker">
              Menu to edit
            </label>
            <select
              id="menu-picker"
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              className={`${fieldClass} w-64`}
            >
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          aria-label="Create a menu"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim() === '') {
              setCreateError('Give the new menu a name.');
              return;
            }
            create.mutate(newName.trim());
          }}
        >
          <div>
            <label className={labelClass} htmlFor="new-menu-name">
              New menu name
            </label>
            <input
              id="new-menu-name"
              value={newName}
              maxLength={100}
              onChange={(e) => setNewName(e.target.value)}
              className={`${fieldClass} w-56`}
            />
          </div>
          <button type="submit" className={buttonClass} disabled={create.isPending}>
            Create menu
          </button>
        </form>
        {createError && (
          <p role="alert" className="w-full text-sm text-red-800">
            {createError}
          </p>
        )}
      </div>

      {selected ? (
        <MenuEditor key={selected.id} menu={selected} />
      ) : (
        <p className="text-slate-700">No menus yet. Create one to get started.</p>
      )}
      <LocationsPanel menus={list} />
    </section>
  );
}
