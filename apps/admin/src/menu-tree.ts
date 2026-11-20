/** Editing helpers for a menu's nested links. Everything here is pure: each returns a new tree. */

export const MAX_MENU_DEPTH = 3;
export const MAX_MENU_ITEMS = 200;

export interface MenuItem {
  label: string;
  url: string;
  target?: '_blank';
  children: MenuItem[];
}

/** Where an item is: the index at each level, outermost first. */
export type ItemPath = readonly number[];

export interface FlatItem {
  path: ItemPath;
  /** 1 for top-level links. */
  depth: number;
  item: MenuItem;
}

export function flattenItems(items: readonly MenuItem[], base: ItemPath = []): FlatItem[] {
  return items.flatMap((item, index) => {
    const path = [...base, index];
    return [{ path, depth: path.length, item }, ...flattenItems(item.children, path)];
  });
}

export function countItems(items: readonly MenuItem[]): number {
  return items.reduce((sum, item) => sum + 1 + countItems(item.children), 0);
}

/** Levels in the tree: 0 for no items, 1 for a flat list. */
export function treeDepth(items: readonly MenuItem[]): number {
  return items.reduce((deepest, item) => Math.max(deepest, 1 + treeDepth(item.children)), 0);
}

function siblingsAt(items: readonly MenuItem[], parent: ItemPath): readonly MenuItem[] | undefined {
  let list: readonly MenuItem[] = items;
  for (const index of parent) {
    const next = list[index];
    if (!next) return undefined;
    list = next.children;
  }
  return list;
}

export function getItem(items: readonly MenuItem[], path: ItemPath): MenuItem | undefined {
  const index = path[path.length - 1];
  if (index === undefined) return undefined;
  return siblingsAt(items, path.slice(0, -1))?.[index];
}

/** Rebuild the list at `parent`, applying `change` to it. Returns the original when `parent` is wrong. */
function withSiblings(
  items: readonly MenuItem[],
  parent: ItemPath,
  change: (list: MenuItem[]) => MenuItem[],
): MenuItem[] {
  if (parent.length === 0) return change([...items]);
  const [head, ...rest] = parent as [number, ...number[]];
  const target = items[head];
  if (!target) return [...items];
  return items.map((item, index) =>
    index === head ? { ...item, children: withSiblings(item.children, rest, change) } : item,
  );
}

export function newItem(label: string, url: string, newTab = false): MenuItem {
  return {
    label: label.trim(),
    url: url.trim(),
    ...(newTab ? { target: '_blank' as const } : {}),
    children: [],
  };
}

/** Add a link at the end of the top level (or of `parent`'s children). */
export function addItem(
  items: readonly MenuItem[],
  item: MenuItem,
  parent: ItemPath = [],
): MenuItem[] {
  if (parent.length > 0 && !getItem(items, parent)) return [...items];
  if (parent.length + 1 + treeDepth(item.children) > MAX_MENU_DEPTH) return [...items];
  if (countItems(items) + 1 + countItems(item.children) > MAX_MENU_ITEMS) return [...items];
  return withSiblings(items, parent, (list) => [...list, item]);
}

export type ItemPatch = Partial<Pick<MenuItem, 'label' | 'url'>> & { newTab?: boolean };

export function updateItem(
  items: readonly MenuItem[],
  path: ItemPath,
  patch: ItemPatch,
): MenuItem[] {
  const index = path[path.length - 1];
  if (index === undefined) return [...items];
  return withSiblings(items, path.slice(0, -1), (list) =>
    list.map((item, i) => {
      if (i !== index) return item;
      const { newTab, ...fields } = patch;
      const next: MenuItem = { ...item, ...fields };
      if (newTab === true) next.target = '_blank';
      if (newTab === false) delete next.target;
      return next;
    }),
  );
}

/** Remove a link together with the links nested under it. */
export function removeItem(items: readonly MenuItem[], path: ItemPath): MenuItem[] {
  const index = path[path.length - 1];
  if (index === undefined) return [...items];
  return withSiblings(items, path.slice(0, -1), (list) => list.filter((_, i) => i !== index));
}

export const canMoveUp = (path: ItemPath): boolean => (path[path.length - 1] ?? 0) > 0;

export function canMoveDown(items: readonly MenuItem[], path: ItemPath): boolean {
  const index = path[path.length - 1];
  const list = siblingsAt(items, path.slice(0, -1));
  return index !== undefined && list !== undefined && index < list.length - 1;
}

/** Swap with the previous or next sibling (the nested links move along). */
export function moveItem(
  items: readonly MenuItem[],
  path: ItemPath,
  direction: 'up' | 'down',
): MenuItem[] {
  const index = path[path.length - 1];
  if (index === undefined) return [...items];
  if (direction === 'up' ? !canMoveUp(path) : !canMoveDown(items, path)) return [...items];
  const other = direction === 'up' ? index - 1 : index + 1;
  return withSiblings(items, path.slice(0, -1), (list) => {
    const a = list[index]!;
    const b = list[other]!;
    list[index] = b;
    list[other] = a;
    return list;
  });
}

/** Indent makes the link the last child of the sibling above it, if that stays within the depth limit. */
export function canIndent(items: readonly MenuItem[], path: ItemPath): boolean {
  const item = getItem(items, path);
  return !!item && canMoveUp(path) && path.length + 1 + treeDepth(item.children) <= MAX_MENU_DEPTH;
}

export function indentItem(items: readonly MenuItem[], path: ItemPath): MenuItem[] {
  if (!canIndent(items, path)) return [...items];
  const item = getItem(items, path)!;
  const parent = path.slice(0, -1);
  const index = path[path.length - 1]!;
  return withSiblings(items, parent, (list) => {
    const above = list[index - 1]!;
    list.splice(index, 1);
    list[index - 1] = { ...above, children: [...above.children, item] };
    return list;
  });
}

/** Outdent makes the link the next sibling of its parent. Top-level links cannot be outdented. */
export const canOutdent = (path: ItemPath): boolean => path.length > 1;

export function outdentItem(items: readonly MenuItem[], path: ItemPath): MenuItem[] {
  if (!canOutdent(path)) return [...items];
  const item = getItem(items, path);
  if (!item) return [...items];
  const grandparent = path.slice(0, -2);
  const parentIndex = path[path.length - 2]!;
  const index = path[path.length - 1]!;
  return withSiblings(items, grandparent, (list) => {
    const parent = list[parentIndex]!;
    list[parentIndex] = { ...parent, children: parent.children.filter((_, i) => i !== index) };
    list.splice(parentIndex + 1, 0, item);
    return list;
  });
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The same rule the server applies: a site path, an http(s) URL, `mailto:` or `tel:`. */
export function isSafeUrl(url: string): boolean {
  if (url === '' || url.length > 2000 || CONTROL.test(url)) return false;
  if (/\s/.test(url) && !url.toLowerCase().startsWith('tel:')) return false;
  if (url.startsWith('/')) return !url.startsWith('//') && !url.includes('\\');
  return /^(?:https?:\/\/[^\s/?#]+|mailto:\S+|tel:[+0-9().\s-]+$)/i.test(url);
}

/** A problem with a new link's fields, or `null` when they are fine. */
export function linkProblem(label: string, url: string): string | null {
  const trimmed = label.trim();
  if (trimmed === '' || trimmed.length > 100) return 'Give the link a label of up to 100 characters.';
  if (!isSafeUrl(url.trim())) {
    return 'The address must be a site path such as /about, an http(s) address, mailto: or tel:.';
  }
  return null;
}

/** The first link in the tree that would be refused, as `label: problem`. */
export function firstItemProblem(items: readonly MenuItem[]): string | null {
  for (const { item } of flattenItems(items)) {
    const problem = linkProblem(item.label, item.url);
    if (problem) return `${item.label.trim() || '(no label)'}: ${problem}`;
  }
  return null;
}

export function sameItems(a: readonly MenuItem[], b: readonly MenuItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
