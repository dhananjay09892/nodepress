import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { logout } from '../api.js';
import { NAV_ITEMS } from '../nav.js';
import { sessionQuery } from '../session.js';

const linkClass = 'block rounded px-3 py-2 text-sm text-slate-200 hover:bg-slate-700';
const activeClass = { className: `${linkClass} bg-slate-700 font-medium text-white` };

export function Shell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useSuspenseQuery(sessionQuery);

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
          <Link to="/" activeOptions={{ exact: true }} className={linkClass} activeProps={activeClass}>
            Dashboard
          </Link>
          {NAV_ITEMS.map((item) => (
            <Link key={item.to} to={item.to} className={linkClass} activeProps={activeClass}>
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
