import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, describeError } from '../api.js';
import { sessionQuery } from '../session.js';
import {
  createUser,
  deleteUser,
  describeUserError,
  diffUser,
  fetchUsers,
  filterUsers,
  pageOfUsers,
  resetPassword,
  roleLabel,
  updateUser,
  userPageCount,
  validateNewUser,
  validatePassword,
  type UserItem,
} from '../users.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass = 'w-full rounded border border-slate-400 px-3 py-1.5 text-slate-900';

function message(error: unknown): string {
  return error instanceof ApiError ? describeUserError(error.code) : describeError(error);
}

function EditPanel({
  user,
  roles,
  others,
  isSelf,
  onSaved,
  onDeleted,
  onClose,
}: {
  user: UserItem;
  roles: string[];
  others: UserItem[];
  isSelf: boolean;
  onSaved: (text: string) => void;
  onDeleted: (text: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState(user.role);

  // Choosing another user, or saving this one, resets the form to what is stored.
  useEffect(() => {
    setDisplayName(user.displayName);
    setEmail(user.email);
    setRole(user.role);
  }, [user.id, user.displayName, user.email, user.role]);

  const patch = diffUser(user, { displayName, email, role });
  const changed = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return updateUser(user.id, patch, session.csrfToken);
    },
    onSuccess: async (saved) => {
      onSaved(`Saved ${saved.displayName}.`);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      // The signed-in user's own name appears in the sidebar.
      if (isSelf) await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) save.mutate();
  };

  return (
    <aside aria-label="Edit user" className="w-full space-y-3 bg-white p-4 shadow lg:w-80">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Edit user</h2>
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label htmlFor="user-name" className="block text-sm font-medium text-slate-700">
            Display name
          </label>
          <input
            id="user-name"
            value={displayName}
            maxLength={200}
            onChange={(e) => setDisplayName(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="user-email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="user-email"
            type="email"
            value={email}
            maxLength={254}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="user-role" className="block text-sm font-medium text-slate-700">
            Role
          </label>
          <select
            id="user-role"
            value={role}
            disabled={isSelf}
            aria-describedby={isSelf ? 'user-role-note' : undefined}
            onChange={(e) => setRole(e.target.value)}
            className={fieldClass}
          >
            {(roles.includes(user.role) ? roles : [user.role, ...roles]).map((name) => (
              <option key={name} value={name}>
                {roleLabel(name)}
              </option>
            ))}
          </select>
          {isSelf && (
            <p id="user-role-note" className="mt-1 text-xs text-slate-700">
              You cannot change your own role.
            </p>
          )}
        </div>
        {save.isError && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
            {message(save.error)}
          </p>
        )}
        <button type="submit" className={buttonClass} disabled={!changed || save.isPending}>
          Save changes
        </button>
      </form>
      <ResetPassword user={user} isSelf={isSelf} />
      {!isSelf && <DeletePanel user={user} others={others} onDeleted={onDeleted} />}
    </aside>
  );
}

function AddPanel({
  roles,
  onCreated,
  onClose,
}: {
  roles: string[];
  onCreated: (user: UserItem) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('subscriber');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return createUser({ email, password, displayName, role }, session.csrfToken);
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onCreated(created);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateNewUser({ email, password });
    setProblem(found);
    if (!found) create.mutate();
  };

  return (
    <aside aria-label="Add user" className="w-full space-y-3 bg-white p-4 shadow lg:w-80">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Add user</h2>
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="new-user-name" className="block text-sm font-medium text-slate-700">
            Display name
          </label>
          <input
            id="new-user-name"
            value={displayName}
            maxLength={200}
            onChange={(e) => setDisplayName(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="new-user-email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="new-user-email"
            type="email"
            value={email}
            maxLength={254}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="new-user-password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            id="new-user-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="new-user-role" className="block text-sm font-medium text-slate-700">
            Role
          </label>
          <select
            id="new-user-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className={fieldClass}
          >
            {roles.map((name) => (
              <option key={name} value={name}>
                {roleLabel(name)}
              </option>
            ))}
          </select>
        </div>
        {(problem || create.isError) && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
            {problem ?? message(create.error)}
          </p>
        )}
        <button type="submit" className={buttonClass} disabled={create.isPending}>
          Create user
        </button>
      </form>
    </aside>
  );
}

function ResetPassword({ user, isSelf }: { user: UserItem; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setPassword('');
    setProblem(null);
    setDone(false);
  }, [user.id]);

  const reset = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return resetPassword(user.id, password, session.csrfToken);
    },
    onSuccess: async () => {
      setPassword('');
      setDone(true);
      // Your own sessions end too, so the app returns you to the sign-in screen.
      if (isSelf) await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    const found = validatePassword(password);
    setProblem(found);
    if (!found) reset.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 border-t border-slate-300 pt-3" noValidate>
      <h3 className="text-base font-semibold text-slate-900">Set a new password</h3>
      <div>
        <label htmlFor="user-new-password" className="block text-sm font-medium text-slate-700">
          New password
        </label>
        <input
          id="user-new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={fieldClass}
        />
        <p className="mt-1 text-xs text-slate-700">
          This signs {isSelf ? 'you' : 'them'} out everywhere.
        </p>
      </div>
      {(problem || reset.isError) && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {problem ?? message(reset.error)}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-slate-800">
          Password changed for {user.displayName}.
        </p>
      )}
      <button type="submit" className={buttonClass} disabled={reset.isPending}>
        Set password
      </button>
    </form>
  );
}

function DeletePanel({
  user,
  others,
  onDeleted,
}: {
  user: UserItem;
  others: UserItem[];
  onDeleted: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reassignTo, setReassignTo] = useState('');

  useEffect(() => {
    setConfirming(false);
    setReassignTo('');
  }, [user.id]);

  const remove = useMutation({
    mutationFn: () => {
      const session = queryClient.getQueryData(sessionQuery.queryKey);
      if (!session) throw new Error('signed out');
      return deleteUser(
        user.id,
        session.csrfToken,
        reassignTo === '' ? undefined : Number(reassignTo),
      );
    },
    onSuccess: async () => {
      onDeleted(`Deleted ${user.displayName}.`);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  if (!confirming) {
    return (
      <div className="border-t border-slate-300 pt-3">
        <button type="button" className={buttonClass} onClick={() => setConfirming(true)}>
          Delete user
        </button>
      </div>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="delete-title"
      className="space-y-3 border-t border-slate-300 pt-3"
    >
      <h3 id="delete-title" className="text-base font-semibold text-slate-900">
        Delete {user.displayName}?
      </h3>
      <p className="text-sm text-slate-800">This cannot be undone. Their sessions end now.</p>
      <div>
        <label htmlFor="delete-reassign" className="block text-sm font-medium text-slate-700">
          Their content
        </label>
        <select
          id="delete-reassign"
          value={reassignTo}
          onChange={(e) => setReassignTo(e.target.value)}
          className={fieldClass}
        >
          <option value="">Keep it, with no author</option>
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              Reassign to {other.displayName}
            </option>
          ))}
        </select>
      </div>
      {remove.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {message(remove.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Confirm delete
        </button>
        <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Users() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
    placeholderData: keepPreviousData,
  });
  const session = queryClient.getQueryData(sessionQuery.queryKey);

  const all = list.data?.users;
  const filtered = useMemo(() => filterUsers(all ?? [], { search, role }), [all, search, role]);
  const pages = userPageCount(filtered.length);
  const current = Math.min(page, pages - 1);
  const rows = pageOfUsers(filtered, current);
  const roles = list.data?.roles ?? [];
  const selected = (all ?? []).find((u) => u.id === selectedId) ?? null;

  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Users</h1>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="user-search" className="block text-sm font-medium text-slate-700">
            Search users
          </label>
          <input
            id="user-search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="rounded border border-slate-400 px-3 py-1.5 text-slate-900"
          />
        </div>
        <div>
          <label htmlFor="user-role-filter" className="block text-sm font-medium text-slate-700">
            Filter by role
          </label>
          <select
            id="user-role-filter"
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setPage(0);
            }}
            className="rounded border border-slate-400 px-3 py-1.5 text-slate-900"
          >
            <option value="all">All roles</option>
            {roles.map((name) => (
              <option key={name} value={name}>
                {roleLabel(name)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            setStatus(null);
            setSelectedId(null);
            setAdding(true);
          }}
        >
          Add user
        </button>
        <p role="status" className="min-h-6 text-sm text-slate-700">
          {status ?? ''}
        </p>
      </div>

      {list.isError && (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {message(list.error)}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <table className="w-full border-collapse bg-white text-left text-sm shadow">
            <caption className="sr-only">Users</caption>
            <thead>
              <tr className="border-b border-slate-300 text-slate-700">
                <th scope="col" className="px-3 py-2">
                  Name
                </th>
                <th scope="col" className="px-3 py-2">
                  Email
                </th>
                <th scope="col" className="px-3 py-2">
                  Role
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => (
                <tr
                  key={user.id}
                  className={`border-b border-slate-200 ${
                    user.id === selectedId ? 'bg-slate-100' : ''
                  }`}
                >
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      aria-label={`Edit ${user.displayName}`}
                      aria-pressed={user.id === selectedId}
                      onClick={() => {
                        setStatus(null);
                        setAdding(false);
                        setSelectedId(user.id);
                      }}
                      className="font-medium text-slate-900 underline hover:text-slate-600"
                    >
                      {user.displayName}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-slate-800">{user.email}</td>
                  <td className="px-3 py-2 text-slate-800">{roleLabel(user.role)}</td>
                </tr>
              ))}
              {!list.isPending && rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-slate-700">
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <nav
            aria-label="Pagination"
            className="mt-4 flex items-center gap-3 text-sm text-slate-700"
          >
            <button
              type="button"
              className={buttonClass}
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <span>
              Page {current + 1} of {pages} · {filtered.length}{' '}
              {filtered.length === 1 ? 'user' : 'users'}
            </span>
            <button
              type="button"
              className={buttonClass}
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </nav>
        </div>

        {adding && (
          <AddPanel
            roles={roles}
            onCreated={(created) => {
              setStatus(`Added ${created.displayName}.`);
              setAdding(false);
            }}
            onClose={() => setAdding(false)}
          />
        )}
        {selected && !adding && (
          <EditPanel
            user={selected}
            roles={roles}
            others={(all ?? []).filter((u) => u.id !== selected.id)}
            isSelf={selected.id === session?.user.id}
            onSaved={setStatus}
            onDeleted={(text) => {
              setStatus(text);
              setSelectedId(null);
            }}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </section>
  );
}
