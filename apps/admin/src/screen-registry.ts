import { sortScreens, type AdminScreen } from './screen-types.js';

// Every `screens/*.screen.tsx` registers itself; Vite resolves the glob at build time.
const modules = import.meta.glob<{ default: AdminScreen }>('./screens/*.screen.tsx', {
  eager: true,
});

export const SCREENS: AdminScreen[] = sortScreens(Object.values(modules).map((m) => m.default));
