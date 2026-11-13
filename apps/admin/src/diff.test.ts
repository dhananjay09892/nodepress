import { describe, expect, it } from 'vitest';
import { blocksToLines, diffLines, diffRevision } from './diff.js';

const p = (text: string) => ({ type: 'core/paragraph', content: [{ text }] });

describe('blocksToLines', () => {
  it('collects the text of every text block, including nested ones', () => {
    const lines = blocksToLines([
      p('One'),
      { type: 'core/image', attrs: { url: '/x.png' } },
      { type: 'core/list', children: [p('Item a'), p('Item b')] },
      { type: 'core/paragraph', content: [{ text: 'Bold ' }, { text: 'text' }] },
      p('   '),
    ]);
    expect(lines).toEqual(['One', 'Item a', 'Item b', 'Bold text']);
  });
});

describe('diffLines', () => {
  it('marks added and removed lines and keeps shared ones in order', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['a'])).toEqual([{ kind: 'added', text: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ kind: 'removed', text: 'a' }]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('does not freeze on very large inputs', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const out = diffLines(big, [...big].reverse());
    expect(out).toHaveLength(4000);
    expect(out.every((l) => l.kind !== 'same')).toBe(true);
  });
});

describe('diffRevision', () => {
  it('reports title and text changes from the revision to the form', () => {
    const diff = diffRevision(
      { title: 'Old title', body: [p('first'), p('second')] },
      { title: 'New title', body: [p('first'), p('third')] },
    );
    expect(diff.identical).toBe(false);
    expect(diff.title).toEqual([
      { kind: 'removed', text: 'Old title' },
      { kind: 'added', text: 'New title' },
    ]);
    expect(diff.text.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'removed', text: 'second' },
      { kind: 'added', text: 'third' },
    ]);
  });

  it('is identical when nothing differs', () => {
    expect(diffRevision({ title: 'T', body: [p('x')] }, { title: 'T', body: [p('x')] }).identical).toBe(
      true,
    );
  });
});
