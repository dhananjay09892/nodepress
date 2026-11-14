import { request, toError } from './api.js';

/** A user as the users API returns it. */
export interface UserItem {
  id: number;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserList {
  users: UserItem[];
  roles: string[];
}

export const USERS_PAGE_SIZE = 20;

export const ROLE_LABELS: Record<string, string> = {
  administrator: 'Administrator',
  editor: 'Editor',
  author: 'Author',
  contributor: 'Contributor',
  subscriber: 'Subscriber',
};

export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

export interface UserFilter {
  search: string;
  /** A role name, or `all`. */
  role: string;
}

/** Search matches name or email, ignoring case and surrounding spaces; the role must match too. */
export function filterUsers(users: readonly UserItem[], filter: UserFilter): UserItem[] {
  const needle = filter.search.trim().toLowerCase();
  return users.filter(
    (user) =>
      (filter.role === 'all' || user.role === filter.role) &&
      (needle === '' ||
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle)),
  );
}

export function userPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
}

export function pageOfUsers<T>(items: readonly T[], page: number): T[] {
  const start = Math.max(0, Math.floor(page)) * USERS_PAGE_SIZE;
  return items.slice(start, start + USERS_PAGE_SIZE);
}

export async function fetchUsers(): Promise<UserList> {
  const res = await request('/api/v1/users');
  if (!res.ok) throw await toError(res);
  return (await res.json()) as UserList;
}

export interface UserPatch {
  displayName?: string;
  email?: string;
  role?: string;
}

/** Only the fields that differ from the saved user, so an untouched role is never re-sent. */
export function diffUser(saved: UserItem, draft: Required<UserPatch>): UserPatch {
  const patch: UserPatch = {};
  const displayName = draft.displayName.trim();
  const email = draft.email.trim();
  if (displayName !== saved.displayName) patch.displayName = displayName;
  if (email !== saved.email) patch.email = email;
  if (draft.role !== saved.role) patch.role = draft.role;
  return patch;
}

export async function updateUser(
  id: number,
  patch: UserPatch,
  csrfToken: string,
): Promise<UserItem> {
  const res = await request(`/api/v1/users/${id}`, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { user: UserItem }).user;
}

/** A sentence a person can act on, for a users API error code. */
export function describeUserError(code: string): string {
  switch (code) {
    case 'duplicate_email':
      return 'Another user already has that email address.';
    case 'invalid_request':
      return 'Check the name, email and role. The last administrator cannot be demoted, and you cannot change your own role.';
    case 'forbidden':
      return 'You do not have permission to do that.';
    case 'not_found':
      return 'That user no longer exists.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
