import type { ComponentType } from 'react';

/**
 * A sidebar screen that lives in its own file. Files named `screens/<Name>.screen.tsx` that
 * `export default defineScreen({...})` are found by `screen-registry.ts`; no shared list needs
 * editing, so two tasks that add screens never touch the same lines.
 */
export interface AdminScreen {
  id: string;
  /** Route path under `/admin`, for example `/redirects`. */
  path: `/${string}`;
  /** Sidebar label (and the page heading, by convention). */
  label: string;
  /** Sidebar position among registered screens: lower comes first; ties sort by label. */
  order?: number;
  component: ComponentType;
  /**
   * Resolves to a truthy value when the signed-in user may use the screen. A falsy value or an
   * error keeps the sidebar entry hidden (the usual check is the screen's API answering 403).
   */
  available: () => Promise<unknown>;
}

export function defineScreen(screen: AdminScreen): AdminScreen {
  return screen;
}

export function sortScreens(screens: readonly AdminScreen[]): AdminScreen[] {
  return [...screens].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label),
  );
}
