import { request, toError } from './api.js';

/** The custom field core already draws a panel for (the featured image picker). */
const CORE_FIELDS = new Set(['featured_image']);

/** A field of a content type, as `GET /api/v1/content-types` describes it. */
export interface TypeField {
  name: string;
  type: string;
  label?: string;
  description?: string;
  required?: boolean;
  /** Select fields only. */
  options?: string[];
  multiple?: boolean;
  multiline?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
}

/** What the form holds for one field: text for most, a checkbox state for booleans. */
export type FieldDraft = string | boolean;

const EDITABLE_TYPES = new Set(['text', 'number', 'boolean', 'date', 'select']);

/**
 * The fields the "Custom fields" panel draws: text, number, boolean, date and single-choice
 * select fields that core has no panel for. Media, relation, rich text and multi-select fields
 * are skipped for now.
 */
export function panelFields(fields: readonly TypeField[]): TypeField[] {
  return fields.filter(
    (f) =>
      EDITABLE_TYPES.has(f.type) &&
      !CORE_FIELDS.has(f.name) &&
      !(f.type === 'select' && f.multiple === true),
  );
}

/** The form value for a stored value (`undefined` when the item has none). */
export function toDraft(field: TypeField, value: unknown): FieldDraft {
  switch (field.type) {
    case 'boolean':
      return value === true;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    case 'date':
      // The server stores a full timestamp; the date input shows the day.
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
        ? value.slice(0, 10)
        : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/** The drafts for every panel field of an item's `meta`. */
export function toDrafts(
  fields: readonly TypeField[],
  meta: Record<string, unknown> | undefined,
): Record<string, FieldDraft> {
  return Object.fromEntries(panelFields(fields).map((f) => [f.name, toDraft(f, meta?.[f.name])]));
}

/**
 * The value to send for a draft: `null` clears the field, `undefined` means the draft is not a
 * valid value (an unfinished number), which is never sent.
 */
export function fromDraft(field: TypeField, draft: FieldDraft | undefined): unknown {
  if (field.type === 'boolean') return draft === true;
  const text = typeof draft === 'string' ? draft : '';
  if (field.type === 'number') {
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  return text === '' ? null : text;
}

/**
 * The custom field values that differ between `current` and `saved`, ready for `meta`. Values
 * are compared, not text, so "5.0" after a saved "5" is no change and cannot loop autosave.
 */
export function diffCustom(
  fields: readonly TypeField[],
  current: Record<string, FieldDraft>,
  saved: Record<string, FieldDraft>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const field of panelFields(fields)) {
    const next = fromDraft(field, current[field.name]);
    if (next === undefined) continue;
    if (next !== fromDraft(field, saved[field.name])) changed[field.name] = next;
  }
  return changed;
}

/** The content types and their fields. */
export async function fetchTypeFields(type: string): Promise<TypeField[]> {
  const res = await request('/api/v1/content-types');
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { types: { name: string; fields?: TypeField[] }[] };
  return body.types.find((t) => t.name === type)?.fields ?? [];
}
