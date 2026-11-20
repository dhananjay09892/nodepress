import { ApiError, request, toError } from './api.js';

export interface ThemeSettingInfo {
  key: string;
  type: string;
  label: string;
  options?: unknown[];
  default?: unknown;
}

export interface ThemeSettingsOverview {
  theme: { name: string; title: string };
  settings: ThemeSettingInfo[];
  /** Values the customizer saved. */
  saved: Record<string, unknown>;
  /** Values in effect: saved ones over the theme's defaults. */
  values: Record<string, unknown>;
}

/** The theme's settings, or `null` when this user may not edit them (no `edit_theme_options`). */
export async function fetchThemeSettings(): Promise<ThemeSettingsOverview | null> {
  const res = await request('/api/v1/theme-settings');
  if (res.status === 403) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as ThemeSettingsOverview;
}

export class ThemeSettingsApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

/** Save changed values; `null` sends a setting back to the theme's default. */
export async function saveThemeSettings(
  values: Record<string, unknown>,
  csrfToken: string,
): Promise<ThemeSettingsOverview> {
  const res = await request('/api/v1/theme-settings', {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const data = (await res.clone().json()) as { message?: unknown };
      if (typeof data.message === 'string') detail = data.message;
    } catch {
      // Not JSON; the generic message is enough.
    }
    const error = await toError(res);
    throw new ThemeSettingsApiError(error.status, error.code, detail);
  }
  return (await res.json()) as ThemeSettingsOverview;
}

export function describeThemeSettingsError(error: unknown): string {
  if (error instanceof ThemeSettingsApiError) {
    if (error.status === 403) return 'You do not have permission to customize the theme.';
    if (error.status === 400 && error.detail) return error.detail;
  }
  return 'Something went wrong. Try again.';
}

/** The settings that differ from the values in effect: what a Save sends. */
export function changedValues(
  current: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (current[key] !== value) changed[key] = value;
  }
  return changed;
}

/** What "Reset to defaults" sends: `null` for every saved setting. */
export function resetValues(saved: Record<string, unknown>): Record<string, null> {
  return Object.fromEntries(Object.keys(saved).map((key) => [key, null]));
}

/** The front page with the unsaved values applied (only the customizer's user may see them). */
export function previewUrl(values: Record<string, unknown>): string {
  return `/?np_preview=${encodeURIComponent(JSON.stringify(values))}`;
}

/** `#rgb` or `#rrggbb` to [r, g, b] (0 to 255), or `null`. */
export function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join('') : match[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colours (1 to 21), or `null` for a bad colour. */
export function contrastRatio(a: string, b: string): number | null {
  const first = parseHex(a);
  const second = parseHex(b);
  if (!first || !second) return null;
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** A warning when `color` is too faint for link text on a white page (WCAG AA needs 4.5:1), else `null`. */
export function contrastWarning(color: string): string | null {
  const ratio = contrastRatio(color, '#ffffff');
  if (ratio === null || ratio >= 4.5) return null;
  return `This color has a contrast ratio of ${ratio.toFixed(1)}:1 against white. Link text needs at least 4.5:1 to be easy to read (WCAG AA).`;
}
