import { describe, expect, it } from 'vitest';
import {
  changedValues,
  contrastRatio,
  contrastWarning,
  describeThemeSettingsError,
  parseHex,
  previewUrl,
  resetValues,
  ThemeSettingsApiError,
} from './customizer.js';

describe('changedValues and resetValues', () => {
  it('keeps only the settings that differ from the values in effect', () => {
    expect(
      changedValues({ accent: '#000000', layout: 'blog' }, { accent: '#aa0000', layout: 'blog' }),
    ).toEqual({ accent: '#aa0000' });
    expect(changedValues({}, { logo: '' })).toEqual({ logo: '' });
    expect(changedValues({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('resets every saved setting to its default with null', () => {
    expect(resetValues({ accent: '#aa0000', layout: 'business' })).toEqual({
      accent: null,
      layout: null,
    });
    expect(resetValues({})).toEqual({});
  });
});

describe('previewUrl', () => {
  it('puts the values in the query as encoded JSON', () => {
    const url = previewUrl({ accent: '#aa0000' });
    expect(url.startsWith('/?np_preview=')).toBe(true);
    expect(JSON.parse(decodeURIComponent(url.slice('/?np_preview='.length)))).toEqual({
      accent: '#aa0000',
    });
  });
});

describe('colour helpers', () => {
  it('parses 3 and 6 digit hex and refuses anything else', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#0b5cad')).toEqual([11, 92, 173]);
    expect(parseHex('0b5cad')).toBeNull();
    expect(parseHex('#12')).toBeNull();
    expect(parseHex('red')).toBeNull();
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')!).toBeCloseTo(4.48, 1);
    expect(contrastRatio('nope', '#ffffff')).toBeNull();
  });

  it('warns about a faint link colour and stays quiet about a good one', () => {
    expect(contrastWarning('#ffeb3b')).toContain('contrast ratio of 1.');
    expect(contrastWarning('#0b5cad')).toBeNull();
    expect(contrastWarning('not a color')).toBeNull();
  });
});

describe('describeThemeSettingsError', () => {
  it('describes refusals and falls back for anything else', () => {
    expect(describeThemeSettingsError(new ThemeSettingsApiError(403, 'forbidden'))).toContain('permission');
    expect(describeThemeSettingsError(new ThemeSettingsApiError(400, 'invalid_request', 'accent does not accept that value'))).toBe('accent does not accept that value');
    expect(describeThemeSettingsError(new Error('x'))).toContain('Something went wrong');
  });
});
