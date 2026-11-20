import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { fetchMenus } from '../menus.js';
import { sessionQuery } from '../session.js';
import {
  addWidget,
  canMove,
  draftFromInstance,
  listProblem,
  makeWidgetId,
  moveWidget,
  newDraft,
  removeWidget,
  sameDrafts,
  setValue,
  toPayload,
  type WidgetDraft,
  type WidgetField,
  type WidgetTypeInfo,
} from '../widget-list.js';
import {
  describeWidgetError,
  fetchWidgets,
  saveWidgets,
  type WidgetsOverview,
} from '../widgets.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const smallButtonClass =
  'rounded border border-slate-400 bg-white px-2 py-1 text-xs text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full max-w-md rounded border border-slate-400 px-3 py-1.5 text-slate-900';
const labelClass = 'block text-sm font-medium text-slate-700';
const cardClass = 'rounded border border-slate-300 bg-white p-4';

function useCsrf(): string {
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData(sessionQuery.queryKey);
  if (!session) throw new Error('signed out');
  return session.csrfToken;
}

function FieldInput(props: {
  id: string;
  field: WidgetField;
  value: string;
  menus: Array<{ id: number; name: string }>;
  onChange: (value: string) => void;
}) {
  const { id, field, value, menus, onChange } = props;
  if (field.type === 'textarea') {
    return (
      <textarea
        id={id}
        value={value}
        rows={4}
        maxLength={2000}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  if (field.type === 'menu') {
    return (
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      >
        <option value="">Choose a menu</option>
        {menus.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      type={field.type === 'number' ? 'number' : 'text'}
      value={value}
      {...(field.type === 'number'
        ? { min: field.min, max: field.max, step: 1 }
        : { maxLength: 100 })}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    />
  );
}

function AreaEditor(props: {
  area: string;
  label: string;
  overview: WidgetsOverview;
  menus: Array<{ id: number; name: string }>;
}) {
  const { area, label, overview, menus } = props;
  const queryClient = useQueryClient();
  const csrf = useCsrf();
  const types = overview.types;
  const saved = (overview.widgets[area] ?? []).map((w) =>
    draftFromInstance(
      w,
      types.find((t) => t.type === w.type),
    ),
  );
  const savedKey = JSON.stringify(saved);
  const [list, setList] = useState<WidgetDraft[]>(saved);
  const [pick, setPick] = useState(types[0]?.type ?? '');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Show the saved widgets again after a save (`savedKey` changes only when they differ).
  useEffect(() => {
    setList(JSON.parse(savedKey) as WidgetDraft[]);
  }, [savedKey]);

  const dirty = !sameDrafts(list, saved);
  const typeOf = (type: string): WidgetTypeInfo | undefined => types.find((t) => t.type === type);

  const save = useMutation({
    mutationFn: () =>
      saveWidgets({ [area]: list.map((draft) => toPayload(draft, typeOf(draft.type))) }, csrf),
    onSuccess: async (next) => {
      queryClient.setQueryData(['widgets'], next);
      setMessage({ kind: 'ok', text: `${label} widgets saved.` });
    },
    onError: (error) => setMessage({ kind: 'error', text: describeWidgetError(error) }),
  });

  function onSave(event: FormEvent) {
    event.preventDefault();
    const problem = listProblem(list, types);
    if (problem) {
      setMessage({ kind: 'error', text: problem });
      return;
    }
    setMessage(null);
    save.mutate();
  }

  return (
    <form onSubmit={onSave} className={`${cardClass} space-y-4`} aria-label={`${label} widgets`}>
      <h2 className="text-lg font-semibold text-slate-900">{label}</h2>
      {list.length === 0 ? (
        <p className="text-sm text-slate-700">No widgets in this area yet.</p>
      ) : (
        <ul className="space-y-3">
          {list.map((draft, index) => {
            const type = typeOf(draft.type);
            const name = `${type?.title ?? draft.type} widget ${index + 1}`;
            return (
              <li key={draft.id} className="rounded border border-slate-300 bg-slate-50 p-3">
                <fieldset className="space-y-3">
                  <legend className="text-sm font-semibold text-slate-900">
                    {type?.title ?? draft.type}
                  </legend>
                  {!type && (
                    <p className="text-sm text-red-800">
                      This widget type is not available (its plugin may be off). Remove it or turn
                      the plugin back on.
                    </p>
                  )}
                  {type?.fields.map((field) => {
                    const id = `${area}-${draft.id}-${field.name}`;
                    return (
                      <div key={field.name}>
                        <label htmlFor={id} className={labelClass}>
                          {field.label}
                          <span className="sr-only"> of {name}</span>
                        </label>
                        <FieldInput
                          id={id}
                          field={field}
                          value={draft.values[field.name] ?? ''}
                          menus={menus}
                          onChange={(value) => setList(setValue(list, index, field.name, value))}
                        />
                      </div>
                    );
                  })}
                </fieldset>
                <div
                  className="mt-2 flex flex-wrap gap-2"
                  role="group"
                  aria-label={`Arrange ${name}`}
                >
                  <button
                    type="button"
                    className={smallButtonClass}
                    disabled={!canMove(list, index, 'up')}
                    onClick={() => setList(moveWidget(list, index, 'up'))}
                    aria-label={`Move ${name} up`}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className={smallButtonClass}
                    disabled={!canMove(list, index, 'down')}
                    onClick={() => setList(moveWidget(list, index, 'down'))}
                    aria-label={`Move ${name} down`}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className={smallButtonClass}
                    onClick={() => setList(removeWidget(list, index))}
                    aria-label={`Remove ${name}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${area}-add-type`} className={labelClass}>
            Widget type <span className="sr-only">to add to {label}</span>
          </label>
          <select
            id={`${area}-add-type`}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="rounded border border-slate-400 px-3 py-1.5 text-slate-900"
          >
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            const type = typeOf(pick);
            if (type) setList(addWidget(list, newDraft(type, makeWidgetId())));
          }}
        >
          Add widget <span className="sr-only">to {label}</span>
        </button>
      </div>

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={message.kind === 'error' ? 'text-sm text-red-800' : 'text-sm text-green-800'}
        >
          {message.text}
        </p>
      )}
      <button type="submit" className={buttonClass} disabled={!dirty || save.isPending}>
        Save {label} widgets
      </button>
    </form>
  );
}

export function Widgets() {
  const overview = useQuery({ queryKey: ['widgets'], queryFn: fetchWidgets });
  // Menus feed the `menu` widget's choice; without permission the list is just empty.
  const menus = useQuery({ queryKey: ['menus'], queryFn: fetchMenus });

  if (overview.isPending) return <p className="text-slate-700">Loading widgets…</p>;
  if (overview.isError) {
    return (
      <p role="alert" className="text-red-800">
        Widgets could not be loaded.
      </p>
    );
  }
  if (overview.data === null) {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">Widgets</h1>
        <p role="alert" className="mt-2 text-slate-700">
          You do not have permission to edit widgets.
        </p>
      </section>
    );
  }
  const data = overview.data;
  const areas = Object.entries(data.areas);
  return (
    <section className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Widgets</h1>
      {areas.length === 0 ? (
        <p className="text-slate-700">The active theme has no widget areas.</p>
      ) : (
        areas.map(([area, label]) => (
          <AreaEditor
            key={area}
            area={area}
            label={label}
            overview={data}
            menus={(menus.data ?? []).map((m) => ({ id: m.id, name: m.name }))}
          />
        ))
      )}
    </section>
  );
}
