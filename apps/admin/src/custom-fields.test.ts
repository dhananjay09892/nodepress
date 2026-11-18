import { describe, expect, it } from 'vitest';
import {
  diffCustom,
  fromDraft,
  panelFields,
  toDraft,
  toDrafts,
  type TypeField,
} from './custom-fields.js';

const fields: TypeField[] = [
  { name: 'featured_image', type: 'media' },
  { name: 'subtitle', type: 'text', label: 'Subtitle' },
  { name: 'rating', type: 'number' },
  { name: 'sponsored', type: 'boolean' },
  { name: 'event_day', type: 'date' },
  { name: 'mood', type: 'select', options: ['calm', 'loud'] },
  { name: 'moods', type: 'select', options: ['a', 'b'], multiple: true },
  { name: 'related', type: 'relation' },
  { name: 'notes', type: 'richtext' },
];

describe('panelFields', () => {
  it('keeps simple fields core has no panel for', () => {
    expect(panelFields(fields).map((f) => f.name)).toEqual([
      'subtitle',
      'rating',
      'sponsored',
      'event_day',
      'mood',
    ]);
  });
});

describe('drafts', () => {
  it('turns stored values into form values', () => {
    expect(toDrafts(fields, { subtitle: 'Hi', rating: 4.5, event_day: '2027-02-03T00:00:00.000Z' }))
      .toEqual({ subtitle: 'Hi', rating: '4.5', sponsored: false, event_day: '2027-02-03', mood: '' });
    expect(toDraft({ name: 'a', type: 'text' }, 7)).toBe('');
    expect(toDraft({ name: 'a', type: 'boolean' }, true)).toBe(true);
  });

  it('turns form values into values to send', () => {
    const num: TypeField = { name: 'n', type: 'number' };
    expect(fromDraft(num, '')).toBeNull();
    expect(fromDraft(num, '12.5')).toBe(12.5);
    expect(fromDraft(num, '-')).toBeUndefined();
    expect(fromDraft({ name: 't', type: 'text' }, '')).toBeNull();
    expect(fromDraft({ name: 'b', type: 'boolean' }, true)).toBe(true);
  });
});

describe('diffCustom', () => {
  const saved = toDrafts(fields, { subtitle: 'Hi', rating: 5 });

  it('sends nothing when nothing changed', () => {
    expect(diffCustom(fields, { ...saved }, saved)).toEqual({});
  });

  it('sends only the fields that changed, and null to clear', () => {
    expect(diffCustom(fields, { ...saved, subtitle: 'Bye', sponsored: true }, saved)).toEqual({
      subtitle: 'Bye',
      sponsored: true,
    });
    expect(diffCustom(fields, { ...saved, subtitle: '' }, saved)).toEqual({ subtitle: null });
  });

  it('compares values, so "5.0" is no change and an unfinished number is not sent', () => {
    expect(diffCustom(fields, { ...saved, rating: '5.0' }, saved)).toEqual({});
    expect(diffCustom(fields, { ...saved, rating: '-' }, saved)).toEqual({});
  });

  it('ignores fields without a panel', () => {
    expect(diffCustom(fields, { ...saved, featured_image: 'x' }, saved)).toEqual({});
  });
});
