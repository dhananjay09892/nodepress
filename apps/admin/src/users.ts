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

export interface NewUser {
  email: string;
  password: string;
  displayName?: string;
  role?: string;
}

/** Longest password the API accepts (matches `MAX_PASSWORD_LENGTH` in the server). */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * What is wrong with a new user's fields, or `null` when they can be sent. Only what the form
 * can check; the server still decides about duplicates and format.
 */
export function validateNewUser(input: NewUser): string | null {
  if (input.email.trim() === '') return 'Enter an email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return 'Enter a valid email address.';
  return validatePassword(input.password);
}

export function validatePassword(password: string): string | null {
  if (password === '') return 'Enter a password.';
  if (password.length > MAX_PASSWORD_LENGTH) return 'That password is too long.';
  return null;
}

/** Empty optional fields are left out so the server applies its defaults. */
export function newUserPayload(input: NewUser): NewUser {
  const displayName = input.displayName?.trim();
  return {
    email: input.email.trim(),
    password: input.password,
    ...(displayName ? { displayName } : {}),
    ...(input.role ? { role: input.role } : {}),
  };
}

export async function createUser(input: NewUser, csrfToken: string): Promise<UserItem> {
  const res = await request('/api/v1/users', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(newUserPayload(input)),
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { user: UserItem }).user;
}

/** Deletes a user. Their content goes to `reassignTo`, or is kept with no author. */
export async function deleteUser(
  id: number,
  csrfToken: string,
  reassignTo?: number,
): Promise<void> {
  const query = reassignTo === undefined ? '' : `?reassignTo=${reassignTo}`;
  const res = await request(`/api/v1/users/${id}${query}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrfToken },
  });
  if (!res.ok) throw await toError(res);
}

/** Sets a new password; the server ends all of that user's sessions. */
export async function resetPassword(
  id: number,
  password: string,
  csrfToken: string,
): Promise<void> {
  const res = await request(`/api/v1/users/${id}`, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await toError(res);
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
      return 'Check the name, email, role and password. The last administrator cannot be demoted or deleted, and you cannot change your own role or delete yourself.';
    case 'forbidden':
      return 'You do not have permission to do that.';
    case 'not_found':
      return 'That user no longer exists.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
