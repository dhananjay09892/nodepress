import { describe, expect, it } from 'vitest';
import {
  addItem,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  countItems,
  firstItemProblem,
  flattenItems,
  indentItem,
  isSafeUrl,
  linkProblem,
  moveItem,
  newItem,
  outdentItem,
  removeItem,
  treeDepth,
  updateItem,
  type MenuItem,
} from './menu-tree.js';

const leaf = (label: string, children: MenuItem[] = []): MenuItem => ({
  label,
  url: `/${label.toLowerCase()}`,
  children,
});
const names = (items: readonly MenuItem[]): unknown =>
  items.map((i) => (i.children.length ? [i.label, names(i.children)] : i.label));

describe('reading the tree', () => {
  const tree = [leaf('A', [leaf('B', [leaf('C')])]), leaf('D')];

  it('flattens in order with depth and path', () => {
    expect(flattenItems(tree).map((f) => [f.item.label, f.depth, [...f.path]])).toEqual([
      ['A', 1, [0]],
      ['B', 2, [0, 0]],
      ['C', 3, [0, 0, 0]],
      ['D', 1, [1]],
    ]);
  });

  it('counts items and depth', () => {
    expect(countItems(tree)).toBe(4);
    expect(treeDepth(tree)).toBe(3);
    expect(treeDepth([])).toBe(0);
  });
});

describe('add, update and remove', () => {
  it('adds at the top level and under a parent without changing the input', () => {
    const start = [leaf('A')];
    const next = addItem(addItem(start, newItem(' B ', ' /b ', true)), leaf('C'), [0]);
    expect(start).toEqual([leaf('A')]);
    expect(names(next)).toEqual([['A', ['C']], 'B']);
    expect(next[1]).toEqual({ label: 'B', url: '/b', target: '_blank', children: [] });
  });

  it('refuses a fourth level and an unknown parent', () => {
    const deep = [leaf('A', [leaf('B', [leaf('C')])])];
    expect(addItem(deep, leaf('X'), [0, 0, 0])).toEqual(deep);
    expect(addItem(deep, leaf('X'), [5])).toEqual(deep);
  });

  it('refuses more than 200 items', () => {
    const many = Array.from({ length: 200 }, (_, i) => leaf(`L${i}`));
    expect(addItem(many, leaf('extra'))).toHaveLength(200);
  });

  it('updates label, url and the new-tab flag at a nested path', () => {
    const tree = [leaf('A', [leaf('B')])];
    const next = updateItem(tree, [0, 0], { label: 'B2', url: '/b2', newTab: true });
    expect(next[0]!.children[0]).toEqual({
      label: 'B2',
      url: '/b2',
      target: '_blank',
      children: [],
    });
    expect(updateItem(next, [0, 0], { newTab: false })[0]!.children[0]!.target).toBeUndefined();
    expect(tree[0]!.children[0]!.label).toBe('B');
  });

  it('removes a link with its children', () => {
    expect(names(removeItem([leaf('A', [leaf('B')]), leaf('C')], [0]))).toEqual(['C']);
    expect(names(removeItem([leaf('A', [leaf('B')])], [0, 0]))).toEqual(['A']);
  });
});

describe('moving', () => {
  const tree = [leaf('A'), leaf('B', [leaf('B1'), leaf('B2')]), leaf('C')];

  it('knows the first and last cannot move out of range', () => {
    expect(canMoveUp([0])).toBe(false);
    expect(canMoveDown(tree, [2])).toBe(false);
    expect(canMoveUp([1])).toBe(true);
    expect(canMoveDown(tree, [1, 0])).toBe(true);
    expect(canMoveDown(tree, [1, 1])).toBe(false);
  });

  it('moves a link and its children up and down', () => {
    expect(names(moveItem(tree, [1], 'up'))).toEqual([['B', ['B1', 'B2']], 'A', 'C']);
    expect(names(moveItem(tree, [1], 'down'))).toEqual(['A', 'C', ['B', ['B1', 'B2']]]);
    expect(names(moveItem(tree, [1, 1], 'up'))).toEqual(['A', ['B', ['B2', 'B1']], 'C']);
  });

  it('leaves the tree alone when the move is not possible', () => {
    expect(moveItem(tree, [0], 'up')).toEqual(tree);
    expect(moveItem(tree, [2], 'down')).toEqual(tree);
  });
});

describe('indent and outdent', () => {
  it('indents under the sibling above, at the end of its children', () => {
    const tree = [leaf('A', [leaf('A1')]), leaf('B')];
    expect(names(indentItem(tree, [1]))).toEqual([['A', ['A1', 'B']]]);
  });

  it('cannot indent the first link or past three levels', () => {
    const tree = [leaf('A', [leaf('B', [leaf('C'), leaf('D')])])];
    expect(canIndent(tree, [0])).toBe(false);
    expect(canIndent(tree, [0, 0, 1])).toBe(false);
    expect(indentItem(tree, [0, 0, 1])).toEqual(tree);
    // B has a child, so indenting it under a sibling would make four levels.
    const two = [leaf('X'), leaf('Y', [leaf('Y1', [leaf('Y2')])])];
    expect(canIndent(two, [1])).toBe(false);
  });

  it('outdents to just after the parent, keeping later siblings in place', () => {
    const tree = [leaf('A', [leaf('A1'), leaf('A2')]), leaf('B')];
    expect(names(outdentItem(tree, [0, 0]))).toEqual([['A', ['A2']], 'A1', 'B']);
    expect(canOutdent([0])).toBe(false);
    expect(outdentItem(tree, [0])).toEqual(tree);
  });

  it('a link and its subtree can go in and out again', () => {
    const tree = [leaf('A'), leaf('B', [leaf('B1')])];
    expect(outdentItem(indentItem(tree, [1]), [0, 0])).toEqual(tree);
  });
});

describe('validation', () => {
  it('accepts paths, http(s), mailto and tel; refuses scripts and protocol-relative links', () => {
    for (const ok of ['/about', 'https://example.com/x?y=1', 'mailto:a@b.co', 'tel:+1 555-0100']) {
      expect(isSafeUrl(ok)).toBe(true);
    }
    for (const bad of ['', 'javascript:alert(1)', '//evil.test', 'data:text/html,x', '/a b', 'about']) {
      expect(isSafeUrl(bad)).toBe(false);
    }
  });

  it('describes a bad new link and finds the first bad item in a tree', () => {
    expect(linkProblem('Home', '/')).toBeNull();
    expect(linkProblem('  ', '/')).toContain('label');
    expect(linkProblem('Home', 'nope')).toContain('address');
    expect(firstItemProblem([leaf('A', [{ label: 'Bad', url: 'x', children: [] }])])).toContain(
      'Bad:',
    );
    expect(firstItemProblem([leaf('A')])).toBeNull();
  });
});
