import { request, toError } from './api.js';

/** The taxonomies the post edit screen assigns. Both are built in and belong to posts. */
export const CATEGORY_TAXONOMY = 'category';
export const TAG_TAXONOMY = 'tag';

/** The fields of a term the screens use. */
export interface TermItem {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
}

/**
 * The terms of a taxonomy, or `null` when the person may not manage categories. The server
 * answers 403 then, and the edit screen hides the panels instead of showing an error.
 */
export async function fetchTerms(taxonomy: string): Promise<TermItem[] | null> {
  const res = await request(`/api/v1/taxonomies/${encodeURIComponent(taxonomy)}/terms`);
  if (res.status === 403) return null;
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { terms: TermItem[] }).terms;
}

/** Finds the term with this name or creates it (the server never makes a duplicate). */
export async function createTerm(
  taxonomy: string,
  name: string,
  csrfToken: string,
  parentId: number | null = null,
): Promise<TermItem> {
  const res = await request(`/api/v1/taxonomies/${encodeURIComponent(taxonomy)}/terms`, {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, parentId }),
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { term: TermItem }).term;
}

export interface TermRow {
  term: TermItem;
  depth: number;
}

/**
 * The terms in tree order (each parent followed by its children, alphabetical among siblings),
 * with the depth to indent by. A term whose parent is missing is shown at the top level, and a
 * loop in the data cannot hang the screen.
 */
export function orderTermTree(terms: readonly TermItem[]): TermRow[] {
  const known = new Set(terms.map((t) => t.id));
  const children = new Map<number | null, TermItem[]>();
  for (const term of terms) {
    const key = term.parentId !== null && known.has(term.parentId) ? term.parentId : null;
    children.set(key, [...(children.get(key) ?? []), term]);
  }
  const byName = (a: TermItem, b: TermItem) => a.name.localeCompare(b.name) || a.id - b.id;
  const rows: TermRow[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const term of (children.get(parent) ?? []).sort(byName)) {
      if (seen.has(term.id)) continue;
      seen.add(term.id);
      rows.push({ term, depth });
      walk(term.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** `ids` with `id` added, or removed when it is already there. */
export function toggleId(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** True when both lists hold the same ids, in any order. */
export function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

export const MAX_SUGGESTIONS = 8;

/** Tags that match what was typed (case-insensitive) and are not chosen yet. */
export function tagSuggestions(
  terms: readonly TermItem[],
  selected: readonly number[],
  query: string,
): TermItem[] {
  const needle = query.trim().toLowerCase();
  return terms
    .filter((t) => !selected.includes(t.id) && t.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, MAX_SUGGESTIONS);
}

/** The existing tag whose name equals what was typed, ignoring case and surrounding space. */
export function exactTerm(terms: readonly TermItem[], query: string): TermItem | undefined {
  const needle = query.trim().toLowerCase();
  return needle === '' ? undefined : terms.find((t) => t.name.toLowerCase() === needle);
}

/** Looks up chosen ids in the term list, keeping the order the person chose them in. */
export function termsById(terms: readonly TermItem[], ids: readonly number[]): TermItem[] {
  const index = new Map(terms.map((t) => [t.id, t]));
  return ids.flatMap((id) => {
    const term = index.get(id);
    return term ? [term] : [];
  });
}
