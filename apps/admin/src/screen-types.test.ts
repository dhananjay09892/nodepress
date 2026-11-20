import { describe, expect, it } from 'vitest';
import { defineScreen, sortScreens } from './screen-types.js';

const make = (id: string, label: string, order?: number) =>
  defineScreen({
    id,
    path: `/${id}`,
    label,
    ...(order === undefined ? {} : { order }),
    component: () => null,
    available: async () => true,
  });

describe('sortScreens', () => {
  it('orders by order, then label, without changing the input', () => {
    const input = [make('b', 'Beta'), make('c', 'Charlie', 5), make('a', 'Alpha'), make('d', 'Delta', 5)];
    expect(sortScreens(input).map((s) => s.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(input.map((s) => s.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('defineScreen returns the screen unchanged', () => {
    const screen = make('x', 'X');
    expect(defineScreen(screen)).toBe(screen);
  });
});
