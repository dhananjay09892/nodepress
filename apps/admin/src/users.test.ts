import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  describeUserError,
  createUser,
  deleteUser,
  diffUser,
  fetchUsers,
  filterUsers,
  newUserPayload,
  pageOfUsers,
  resetPassword,
  roleLabel,
  updateUser,
  userPageCount,
  USERS_PAGE_SIZE,
  validateNewUser,
  validatePassword,
  type UserItem,
} from './users.js';

const user = (id: number, displayName: string, email: string, role = 'author'): UserItem => ({
  id,
  displayName,
  email,
  role,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const people = [
  user(1, 'Ada Lovelace', 'ada@example.com', 'administrator'),
  user(2, 'Grace Hopper', 'grace@navy.example', 'editor'),
  user(3, 'Alan Turing', 'alan@example.com'),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('filterUsers', () => {
  it('returns everyone for an empty search and the all role', () => {
    expect(filterUsers(people, { search: '  ', role: 'all' })).toHaveLength(3);
  });

  it('matches name or email, ignoring case and spaces', () => {
    expect(filterUsers(people, { search: ' GRACE ', role: 'all' }).map((u) => u.id)).toEqual([2]);
    expect(filterUsers(people, { search: 'example.com', role: 'all' }).map((u) => u.id)).toEqual([
      1, 3,
    ]);
  });

  it('combines the search with a role', () => {
    expect(filterUsers(people, { search: 'example.com', role: 'author' }).map((u) => u.id)).toEqual(
      [3],
    );
    expect(filterUsers(people, { search: 'grace', role: 'author' })).toEqual([]);
  });
});

describe('paging', () => {
  it('counts at least one page', () => {
    expect(userPageCount(0)).toBe(1);
    expect(userPageCount(USERS_PAGE_SIZE)).toBe(1);
    expect(userPageCount(USERS_PAGE_SIZE + 1)).toBe(2);
  });

  it('slices pages and never goes below the first', () => {
    const items = Array.from({ length: USERS_PAGE_SIZE + 3 }, (_, i) => i);
    expect(pageOfUsers(items, 0)).toHaveLength(USERS_PAGE_SIZE);
    expect(pageOfUsers(items, 1)).toEqual([
      USERS_PAGE_SIZE,
      USERS_PAGE_SIZE + 1,
      USERS_PAGE_SIZE + 2,
    ]);
    expect(pageOfUsers(items, -4)).toHaveLength(USERS_PAGE_SIZE);
  });
});

describe('diffUser', () => {
  const saved = people[2]!;

  it('is empty when nothing changed (trimming first)', () => {
    expect(
      diffUser(saved, { displayName: ' Alan Turing ', email: saved.email, role: saved.role }),
    ).toEqual({});
  });

  it('includes only the changed fields', () => {
    expect(
      diffUser(saved, { displayName: saved.displayName, email: saved.email, role: 'editor' }),
    ).toEqual({ role: 'editor' });
    expect(
      diffUser(saved, { displayName: 'Al', email: 'al@example.com', role: saved.role }),
    ).toEqual({ displayName: 'Al', email: 'al@example.com' });
  });
});

describe('roleLabel', () => {
  it('names the built-in roles and falls back to the raw value', () => {
    expect(roleLabel('editor')).toBe('Editor');
    expect(roleLabel('shop_manager')).toBe('shop_manager');
  });
});

describe('API calls', () => {
  it('fetchUsers returns the users and roles', async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ users: people, roles: ['editor'] }));
    vi.stubGlobal('fetch', fetchMock);
    const list = await fetchUsers();
    expect(list.users).toHaveLength(3);
    expect(list.roles).toEqual(['editor']);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/users');
  });

  it('fetchUsers throws the API error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'forbidden' }, 403)),
    );
    await expect(fetchUsers()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('updateUser patches with the CSRF token and returns the user', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ user: { ...people[2]!, role: 'editor' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const updated = await updateUser(3, { role: 'editor' }, 'csrf-1');
    expect(updated.role).toBe('editor');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/users/3');
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-1');
    expect(init?.body).toBe(JSON.stringify({ role: 'editor' }));
  });

  it('updateUser surfaces a conflict as an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'duplicate_email' }, 409)),
    );
    const error = await updateUser(3, { email: 'x@example.com' }, 'c').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('duplicate_email');
  });
});

describe('describeUserError', () => {
  it('explains the codes a person can fix', () => {
    expect(describeUserError('duplicate_email')).toMatch(/already has that email/);
    expect(describeUserError('forbidden')).toMatch(/permission/);
    expect(describeUserError('invalid_request')).toMatch(/last administrator/);
    expect(describeUserError('invalid_request')).toMatch(/delete yourself/);
    expect(describeUserError('anything-else')).toMatch(/Something went wrong/);
  });
});

describe('new user form', () => {
  it('checks the email and password before sending', () => {
    expect(validateNewUser({ email: ' ', password: 'pw' })).toMatch(/email/);
    expect(validateNewUser({ email: 'nope', password: 'pw' })).toMatch(/valid email/);
    expect(validateNewUser({ email: 'a@example.com', password: '' })).toMatch(/password/);
    expect(validateNewUser({ email: 'a@example.com', password: 'x'.repeat(5000) })).toMatch(/long/);
    expect(validateNewUser({ email: ' a@example.com ', password: 'pw' })).toBeNull();
    expect(validatePassword('')).not.toBeNull();
    expect(validatePassword('ok')).toBeNull();
  });

  it('trims fields and leaves out empty optional ones', () => {
    expect(
      newUserPayload({ email: ' a@example.com ', password: ' pw ', displayName: '  ', role: '' }),
    ).toEqual({ email: 'a@example.com', password: ' pw ' });
    expect(
      newUserPayload({
        email: 'a@example.com',
        password: 'pw',
        displayName: ' Ada ',
        role: 'editor',
      }),
    ).toEqual({ email: 'a@example.com', password: 'pw', displayName: 'Ada', role: 'editor' });
  });
});

describe('create, delete and reset calls', () => {
  it('createUser posts the trimmed payload with the CSRF token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ user: people[2]! }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    const created = await createUser({ email: ' alan@example.com ', password: 'pw' }, 'csrf-2');
    expect(created.id).toBe(3);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/users');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-2');
    expect(init?.body).toBe(JSON.stringify({ email: 'alan@example.com', password: 'pw' }));
  });

  it('createUser surfaces a duplicate email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'duplicate_email' }, 409)),
    );
    await expect(createUser({ email: 'a@example.com', password: 'pw' }, 'c')).rejects.toMatchObject(
      { status: 409, code: 'duplicate_email' },
    );
  });

  it('deleteUser sends DELETE, with reassignTo only when given', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await deleteUser(3, 'csrf-3');
    await deleteUser(3, 'csrf-3', 1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/users/3');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/users/3?reassignTo=1');
    const init = fetchMock.mock.calls[0]![1];
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-3');
    expect(init?.body).toBeUndefined();
  });

  it('deleteUser throws the API error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'invalid_request' }, 400)),
    );
    await expect(deleteUser(1, 'c')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  it('resetPassword patches only the password', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ user: people[2]! }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await resetPassword(3, 'new password', 'csrf-4');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/users/3');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ password: 'new password' }));
  });
});
