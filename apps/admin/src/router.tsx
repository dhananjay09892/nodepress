import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { Shell } from './screens/Shell.js';
import { Dashboard } from './screens/Dashboard.js';
import { LoginScreen } from './screens/Login.js';
import { ComingSoon } from './screens/ComingSoon.js';
import { ContentList } from './screens/ContentList.js';
import { NAV_ITEMS } from './nav.js';
import { sessionQuery } from './session.js';

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (session) throw redirect({ to: '/' });
  },
  component: LoginScreen,
});

// Every screen except the login lives under this layout, which requires a session.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: '/login' });
  },
  component: Shell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: Dashboard,
});

// Screens that exist; every other sidebar section is still a placeholder.
const contentScreens: Record<string, { type: string; title: string }> = {
  '/posts': { type: 'post', title: 'Posts' },
  '/pages': { type: 'page', title: 'Pages' },
};

const sectionRoutes = NAV_ITEMS.map((item) => {
  const screen = contentScreens[item.to];
  return createRoute({
    getParentRoute: () => shellRoute,
    path: item.to,
    component: screen
      ? () => <ContentList type={screen.type} title={screen.title} />
      : () => <ComingSoon title={item.label} />,
  });
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([dashboardRoute, ...sectionRoutes]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    basepath: '/admin',
    context: { queryClient },
    defaultNotFoundComponent: () => <ComingSoon title="Page not found" />,
  });
}
