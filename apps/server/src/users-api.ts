import {
  DuplicateEmailError,
  ROLES,
  UserNotFoundError,
  UserValidationError,
  type Capabilities,
  type RoleName,
  type User,
  type UsersService,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface UserRoutesOptions {
  users: Pick<UsersService, 'list' | 'findById' | 'create' | 'update'>;
  capabilities: Capabilities;
}

const MAX_BODY_BYTES = 8 * 1024;

/** A user as the API returns it: never the password hash. */
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * Routes for `/api/v1/users`: list, read, create and edit users. Reading needs `list_users`,
 * creating `create_users`, editing `edit_users`, and setting a role other than the default
 * (creating) or changing one (editing) also needs `promote_users`.
 * Nobody can change their own role (so an administrator cannot lock themselves out); the
 * users service still refuses to demote the last administrator.
 */
export function createUserRoutes(auth: Auth, options: UserRoutesOptions): Hono<AuthEnv> {
  const { users, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);

  const allowed = (c: Context<AuthEnv>, capability: string) =>
    capabilities.can(c.get('principal')!.user, capability);

  const parseId = (c: Context<AuthEnv>): number | null => {
    const raw = c.req.param('id') ?? '';
    return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
  };

  const readJson = async (c: Context<AuthEnv>) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return { error: c.json({ error: 'unsupported_media_type' }, 415) } as const;
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return { error: c.json({ error: 'payload_too_large' }, 413) } as const;
    }
    try {
      const body: unknown = JSON.parse(raw);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { error: c.json({ error: 'invalid_request' }, 400) } as const;
      }
      return { body: body as Record<string, unknown> } as const;
    } catch {
      return { error: c.json({ error: 'invalid_json' }, 400) } as const;
    }
  };

  const fail = (c: Context<AuthEnv>, error: unknown) => {
    if (error instanceof UserNotFoundError) return c.json({ error: 'not_found' }, 404);
    if (error instanceof DuplicateEmailError) {
      return c.json({ error: 'duplicate_email', message: error.message }, 409);
    }
    if (error instanceof UserValidationError) {
      return c.json({ error: 'invalid_request', message: error.message }, 400);
    }
    throw error;
  };

  /** A string field, or a 400 naming the first field that has another type. */
  const wrongType = (c: Context<AuthEnv>, fields: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined && typeof value !== 'string') {
        return c.json({ error: 'invalid_request', message: `${name} must be a string` }, 400);
      }
    }
    return null;
  };

  routes.get('/', async (c) => {
    if (!(await allowed(c, 'list_users'))) return c.json({ error: 'forbidden' }, 403);
    const all = await users.list();
    all.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id - b.id);
    return c.json({ users: all.map(publicUser), roles: ROLES });
  });

  routes.post('/', async (c) => {
    if (!(await allowed(c, 'create_users'))) return c.json({ error: 'forbidden' }, 403);
    const parsed = await readJson(c);
    if ('error' in parsed) return parsed.error;
    const { email, password, displayName, role } = parsed.body;
    const typeError = wrongType(c, { email, password, displayName, role });
    if (typeError) return typeError;
    if (typeof email !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'invalid_request', message: 'email and password are required' }, 400);
    }
    if (role !== undefined && role !== 'subscriber' && !(await allowed(c, 'promote_users'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const created = await users.create({
        email,
        password,
        ...(displayName !== undefined ? { displayName: displayName as string } : {}),
        ...(role !== undefined ? { role: role as RoleName } : {}),
      });
      return c.json({ user: publicUser(created) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.get('/:id', async (c) => {
    if (!(await allowed(c, 'list_users'))) return c.json({ error: 'forbidden' }, 403);
    const id = parseId(c);
    const user = id === null ? undefined : await users.findById(id);
    return user ? c.json({ user: publicUser(user) }) : c.json({ error: 'not_found' }, 404);
  });

  routes.patch('/:id', async (c) => {
    if (!(await allowed(c, 'edit_users'))) return c.json({ error: 'forbidden' }, 403);
    const id = parseId(c);
    if (id === null) return c.json({ error: 'not_found' }, 404);

    const parsed = await readJson(c);
    if ('error' in parsed) return parsed.error;
    const body = parsed.body;

    const { email, displayName, role } = body;
    const typeError = wrongType(c, { email, displayName, role });
    if (typeError) return typeError;

    if (role !== undefined) {
      if (!(await allowed(c, 'promote_users'))) return c.json({ error: 'forbidden' }, 403);
      const existing = await users.findById(id);
      if (!existing) return c.json({ error: 'not_found' }, 404);
      if (role !== existing.role && id === c.get('principal')!.user.id) {
        return c.json(
          { error: 'invalid_request', message: 'You cannot change your own role' },
          400,
        );
      }
    }

    try {
      const updated = await users.update(id, {
        ...(email !== undefined ? { email: email as string } : {}),
        ...(displayName !== undefined ? { displayName: displayName as string } : {}),
        ...(role !== undefined ? { role: role as RoleName } : {}),
      });
      return c.json({ user: publicUser(updated) });
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
}
