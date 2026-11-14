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
import { MediaLibrary } from './screens/MediaLibrary.js';
import { Users } from './screens/Users.js';
import { EditorPreview } from './screens/EditorPreview.js';
import { PostEdit } from './screens/PostEdit.js';
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
      : item.to === '/media'
        ? MediaLibrary
        : item.to === '/users'
          ? Users
          : () => <ComingSoon title={item.label} />,
  });
});

// The edit screens. `/posts/new` is static, so it wins over `/posts/$id`. The four routes are
// written out so the router can type-check every link and parameter.
const postNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/posts/new',
  component: () => <PostEdit type="post" noun="Post" />,
});
const postEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/posts/$id',
  component: () => <PostEdit type="post" noun="Post" />,
});
const pageNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/pages/new',
  component: () => <PostEdit type="page" noun="Page" />,
});
const pageEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/pages/$id',
  component: () => <PostEdit type="page" noun="Page" />,
});

// Temporary, unlinked route for trying the block editor on its own (nothing is saved).
const editorPreviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/editor-preview',
  component: EditorPreview,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    dashboardRoute,
    ...sectionRoutes,
    postNewRoute,
    postEditRoute,
    pageNewRoute,
    pageEditRoute,
    editorPreviewRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    basepath: '/admin',
    context: { queryClient },
    defaultNotFoundComponent: () => <ComingSoon title="Page not found" />,
  });
}
