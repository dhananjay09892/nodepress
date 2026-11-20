import { describe, expect, it } from 'vitest';
import {
  MAX_WIDGETS_PER_AREA,
  addWidget,
  canMove,
  draftFromInstance,
  draftProblem,
  listProblem,
  makeWidgetId,
  moveWidget,
  newDraft,
  removeWidget,
  sameDrafts,
  setValue,
  toPayload,
  type WidgetDraft,
  type WidgetTypeInfo,
} from './widget-list.js';

const text: WidgetTypeInfo = {
  type: 'text',
  title: 'Text',
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'text', label: 'Text', type: 'textarea', required: true },
  ],
};
const recent: WidgetTypeInfo = {
  type: 'recent-posts',
  title: 'Recent posts',
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'count', label: 'Number of posts', type: 'number', min: 1, max: 20 },
  ],
};
const menu: WidgetTypeInfo = {
  type: 'menu',
  title: 'Menu',
  fields: [{ name: 'menuId', label: 'Menu', type: 'menu', required: true }],
};

const d = (id: string): WidgetDraft => ({ id, type: 'text', values: { title: '', text: id } });

describe('building drafts', () => {
  it('turns stored settings into form text and leaves unset ones empty', () => {
    expect(
      draftFromInstance({ id: 'a', type: 'recent-posts', settings: { count: 3 } }, recent),
    ).toEqual({ id: 'a', type: 'recent-posts', values: { title: '', count: '3' } });
    expect(
      draftFromInstance({ id: 'a', type: 'gone', settings: { x: 1 } }, undefined).values,
    ).toEqual({});
  });

  it('starts a new widget empty, with the lowest number for number fields', () => {
    expect(newDraft(text, 'n1')).toEqual({
      id: 'n1',
      type: 'text',
      values: { title: '', text: '' },
    });
    expect(newDraft(recent, 'n2').values).toEqual({ title: '', count: '1' });
  });

  it('makes ids the server accepts', () => {
    const id = makeWidgetId();
    expect(id).toMatch(/^w_[0-9a-f]{12}$/);
    expect(makeWidgetId((b) => void b.fill(255))).toBe('w_ffffffffffff');
  });
});

describe('editing the list', () => {
  it('adds up to the maximum and removes by position without changing the input', () => {
    const list = [d('a'), d('b')];
    expect(addWidget(list, d('c')).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(removeWidget(list, 0).map((w) => w.id)).toEqual(['b']);
    expect(list).toHaveLength(2);
    const full = Array.from({ length: MAX_WIDGETS_PER_AREA }, (_, i) => d(`w${i}`));
    expect(addWidget(full, d('extra'))).toHaveLength(MAX_WIDGETS_PER_AREA);
  });

  it('moves up and down, and ignores moves off either end', () => {
    const list = [d('a'), d('b'), d('c')];
    expect(moveWidget(list, 1, 'up').map((w) => w.id)).toEqual(['b', 'a', 'c']);
    expect(moveWidget(list, 1, 'down').map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(moveWidget(list, 0, 'up').map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(moveWidget(list, 2, 'down').map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(canMove(list, 0, 'up')).toBe(false);
    expect(canMove(list, 2, 'down')).toBe(false);
    expect(canMove(list, 1, 'down')).toBe(true);
  });

  it('sets one value of one widget', () => {
    const next = setValue([d('a'), d('b')], 1, 'text', 'changed');
    expect(next[1]!.values.text).toBe('changed');
    expect(next[0]!.values.text).toBe('a');
  });

  it('compares lists by content', () => {
    expect(sameDrafts([d('a')], [d('a')])).toBe(true);
    expect(sameDrafts([d('a')], [d('b')])).toBe(false);
  });
});

describe('checking and sending', () => {
  it('requires required fields and whole numbers in range', () => {
    expect(draftProblem(newDraft(text, 'x'), text)).toBe('Text: Text is required.');
    expect(draftProblem(setValue([newDraft(text, 'x')], 0, 'text', 'hi')[0]!, text)).toBeNull();
    const bad = (count: string) =>
      draftProblem({ id: 'x', type: 'recent-posts', values: { title: '', count } }, recent);
    expect(bad('99')).toContain('whole number from 1 to 20');
    expect(bad('2.5')).toContain('whole number');
    expect(bad('')).toBeNull();
    expect(bad('5')).toBeNull();
    expect(draftProblem(d('x'), undefined)).toContain('not available');
  });

  it('finds the first problem in a list', () => {
    expect(listProblem([d('a'), newDraft(text, 'b')], [text])).toBe('Text: Text is required.');
    expect(listProblem([d('a')], [text])).toBeNull();
  });

  it('builds the payload: blank optional values dropped, numbers and menu ids converted', () => {
    expect(toPayload({ id: 'a', type: 'text', values: { title: '', text: ' Hi ' } }, text)).toEqual(
      {
        id: 'a',
        type: 'text',
        settings: { text: ' Hi ' },
      },
    );
    expect(
      toPayload({ id: 'b', type: 'recent-posts', values: { title: 'New', count: '4' } }, recent)
        .settings,
    ).toEqual({ title: 'New', count: 4 });
    expect(toPayload({ id: 'c', type: 'menu', values: { menuId: '7' } }, menu).settings).toEqual({
      menuId: 7,
    });
  });
});
