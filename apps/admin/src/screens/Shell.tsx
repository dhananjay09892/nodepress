import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { logout } from '../api.js';
import { fetchExtensions } from '../extensions.js';
import { fetchMenus } from '../menus.js';
import { fetchThemeSettings } from '../customizer.js';
import { fetchPlugins } from '../plugins.js';
import { fetchWidgets } from '../widgets.js';
import { SCREENS } from '../screen-registry.js';
import type { AdminScreen } from '../screen-types.js';
import { NAV_ITEMS } from '../nav.js';
import { sessionQuery } from '../session.js';

const linkClass = 'block rounded px-3 py-2 text-sm text-slate-200 hover:bg-slate-700';
const activeClass = { className: `${linkClass} bg-slate-700 font-medium text-white` };

/** A sidebar link for a self-registered screen; hidden until its `available` check passes. */
function ScreenLink({ screen }: { screen: AdminScreen }) {
  const allowed = useQuery({
    queryKey: ['screen-available', screen.id],
    queryFn: screen.available,
    staleTime: 60_000,
    retry: false,
  });
  return allowed.data ? (
    <Link to={screen.path as never} className={linkClass} activeProps={activeClass}>
      {screen.label}
    </Link>
  ) : null;
}

export function Shell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useSuspenseQuery(sessionQuery);

  // Menu items added by plugins. If this fails the sidebar simply shows no plugin items.
  const extensions = useQuery({
    queryKey: ['admin-extensions'],
    queryFn: fetchExtensions,
    staleTime: 60_000,
  });

  // The Menus entry is only for users who may edit menus (`edit_theme_options`): the menus API
  // answers 403 for everyone else. Any other failure keeps the entry hidden.
  const menus = useQuery({
    queryKey: ['menus'],
    queryFn: fetchMenus,
    staleTime: 60_000,
  });

  // Same idea for Widgets: the widgets API answers 403 without `edit_theme_options`.
  const widgets = useQuery({
    queryKey: ['widgets'],
    queryFn: fetchWidgets,
    staleTime: 60_000,
  });

  // Plugins: the plugins API answers 403 without `manage_plugins`.
  const plugins = useQuery({
    queryKey: ['plugins'],
    queryFn: fetchPlugins,
    staleTime: 60_000,
  });

  // And the customizer; it also needs an active theme, so any failure keeps the entry hidden.
  const customizer = useQuery({
    queryKey: ['theme-settings'],
    queryFn: fetchThemeSettings,
    staleTime: 60_000,
    retry: false,
  });

  const signOut = useMutation({
    mutationFn: async () => {
      if (session) await logout(session.csrfToken);
    },
    // Whatever the server said, this browser is done with the session.
    onSettled: async () => {
      queryClient.setQueryData(sessionQuery.queryKey, null);
      await navigate({ to: '/login' });
    },
  });

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="flex w-60 shrink-0 flex-col bg-slate-900 p-4">
        <p className="mb-6 px-3 text-lg font-semibold text-white">NodePress</p>
        <nav aria-label="Main" className="flex-1 space-y-1">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={linkClass}
            activeProps={activeClass}
          >
            Dashboard
          </Link>
          {NAV_ITEMS.map((item) => (
            <Link key={item.to} to={item.to} className={linkClass} activeProps={activeClass}>
              {item.label}
            </Link>
          ))}
          {menus.data ? (
            <Link to="/menus" className={linkClass} activeProps={activeClass}>
              Menus
            </Link>
          ) : null}
          {widgets.data ? (
            <Link to="/widgets" className={linkClass} activeProps={activeClass}>
              Widgets
            </Link>
          ) : null}
          {plugins.data ? (
            <Link to="/plugins" className={linkClass} activeProps={activeClass}>
              Plugins
            </Link>
          ) : null}
          {customizer.data ? (
            <Link to="/customize" className={linkClass} activeProps={activeClass}>
              Customize
            </Link>
          ) : null}
          {SCREENS.map((screen) => (
            <ScreenLink key={screen.id} screen={screen} />
          ))}
          {extensions.data?.menu.map((item) => (
            <Link
              key={`${item.plugin}/${item.id}`}
              to="/extensions/$plugin/$page"
              params={{ plugin: item.plugin, page: item.page }}
              className={linkClass}
              activeProps={activeClass}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-700 pt-4">
          <p className="truncate px-3 text-sm text-slate-300" data-testid="current-user">
            {session?.user.displayName}
          </p>
          <button
            type="button"
            onClick={() => signOut.mutate()}
            className="mt-2 w-full rounded px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
