/** Editing helpers for the widgets of one area. Pure: each returns a new list. */

export const MAX_WIDGETS_PER_AREA = 20;

export interface WidgetField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'menu';
  required?: boolean;
  min?: number;
  max?: number;
}

export interface WidgetTypeInfo {
  type: string;
  title: string;
  description?: string;
  fields: WidgetField[];
}

/** A widget as the API stores it. */
export interface WidgetInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
}

/** A widget being edited: every setting is the text of its form control. */
export interface WidgetDraft {
  id: string;
  type: string;
  values: Record<string, string>;
}

export function draftFromInstance(
  instance: WidgetInstance,
  type: WidgetTypeInfo | undefined,
): WidgetDraft {
  const values: Record<string, string> = {};
  for (const field of type?.fields ?? []) {
    const value = instance.settings[field.name];
    values[field.name] = value === undefined || value === null ? '' : String(value);
  }
  return { id: instance.id, type: instance.type, values };
}

/** A new widget with empty settings, or the lowest allowed number for a number field. */
export function newDraft(type: WidgetTypeInfo, id: string): WidgetDraft {
  const values: Record<string, string> = {};
  for (const field of type.fields) {
    values[field.name] =
      field.type === 'number' && field.min !== undefined ? String(field.min) : '';
  }
  return { id, type: type.type, values };
}

/** A random id the server accepts (letters, digits, `-` and `_`, up to 40 characters). */
export function makeWidgetId(
  fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => void crypto.getRandomValues(bytes),
): string {
  const bytes = new Uint8Array(6);
  fill(bytes);
  return `w_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function addWidget(list: readonly WidgetDraft[], draft: WidgetDraft): WidgetDraft[] {
  return list.length >= MAX_WIDGETS_PER_AREA ? [...list] : [...list, draft];
}

export function removeWidget(list: readonly WidgetDraft[], index: number): WidgetDraft[] {
  return list.filter((_, i) => i !== index);
}

export function canMove(
  list: readonly unknown[],
  index: number,
  direction: 'up' | 'down',
): boolean {
  return direction === 'up' ? index > 0 : index >= 0 && index < list.length - 1;
}

export function moveWidget(
  list: readonly WidgetDraft[],
  index: number,
  direction: 'up' | 'down',
): WidgetDraft[] {
  const next = [...list];
  if (!canMove(list, index, direction)) return next;
  const other = direction === 'up' ? index - 1 : index + 1;
  const a = next[index]!;
  next[index] = next[other]!;
  next[other] = a;
  return next;
}

export function setValue(
  list: readonly WidgetDraft[],
  index: number,
  field: string,
  value: string,
): WidgetDraft[] {
  return list.map((draft, i) =>
    i === index ? { ...draft, values: { ...draft.values, [field]: value } } : draft,
  );
}

/** What is wrong with a widget's form, as a sentence, or `null`. */
export function draftProblem(draft: WidgetDraft, type: WidgetTypeInfo | undefined): string | null {
  if (!type) return `The "${draft.type}" widget type is not available.`;
  for (const field of type.fields) {
    const raw = (draft.values[field.name] ?? '').trim();
    if (raw === '') {
      if (field.required) return `${type.title}: ${field.label} is required.`;
      continue;
    }
    if (field.type === 'number') {
      const n = Number(raw);
      if (
        !Number.isInteger(n) ||
        (field.min !== undefined && n < field.min) ||
        (field.max !== undefined && n > field.max)
      ) {
        return `${type.title}: ${field.label} must be a whole number from ${field.min ?? 0} to ${field.max ?? 100}.`;
      }
    }
  }
  return null;
}

/** The first problem in the list, or `null`. */
export function listProblem(
  list: readonly WidgetDraft[],
  types: readonly WidgetTypeInfo[],
): string | null {
  for (const draft of list) {
    const problem = draftProblem(
      draft,
      types.find((t) => t.type === draft.type),
    );
    if (problem) return problem;
  }
  return null;
}

/** The `PUT` body entry for a widget: blank optional settings are left out and numbers converted. */
export function toPayload(draft: WidgetDraft, type: WidgetTypeInfo | undefined): WidgetInstance {
  const settings: Record<string, unknown> = {};
  for (const field of type?.fields ?? []) {
    const raw = draft.values[field.name] ?? '';
    if (raw.trim() === '') continue;
    settings[field.name] = field.type === 'number' || field.type === 'menu' ? Number(raw) : raw;
  }
  return { id: draft.id, type: draft.type, settings };
}

export function sameDrafts(a: readonly WidgetDraft[], b: readonly WidgetDraft[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
