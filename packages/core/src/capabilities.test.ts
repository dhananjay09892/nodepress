import { describe, expect, it } from 'vitest';
import { createCapabilities, DEFAULT_ROLE_CAPABILITIES, isRole, ROLES } from './capabilities.js';
import { HookRegistry } from './hooks.js';

function setup() {
  const hooks = new HookRegistry();
  return { hooks, caps: createCapabilities(hooks) };
}

describe('role defaults', () => {
  it('defines the five roles', () => {
    expect([...ROLES]).toEqual(['administrator', 'editor', 'author', 'contributor', 'subscriber']);
    expect(isRole('editor')).toBe(true);
    expect(isRole('root')).toBe(false);
  });

  it('makes every role a superset of the one below it', () => {
    for (let i = 0; i < ROLES.length - 1; i++) {
      const higher = new Set(DEFAULT_ROLE_CAPABILITIES[ROLES[i]!]);
      for (const cap of DEFAULT_ROLE_CAPABILITIES[ROLES[i + 1]!]) expect(higher.has(cap)).toBe(true);
    }
  });

  it('keeps administrative capabilities for administrators only', async () => {
    const { caps } = setup();
    for (const cap of ['manage_plugins', 'manage_options', 'edit_users']) {
      expect(await caps.can({ role: 'administrator' }, cap)).toBe(true);
      for (const role of ['editor', 'author', 'contributor', 'subscriber']) {
        expect(await caps.can({ role }, cap)).toBe(false);
      }
    }
  });

  it('gives each role its expected content powers', async () => {
    const { caps } = setup();
    expect(await caps.can({ role: 'subscriber' }, 'read')).toBe(true);
    expect(await caps.can({ role: 'subscriber' }, 'edit_posts')).toBe(false);
    expect(await caps.can({ role: 'contributor' }, 'edit_posts')).toBe(true);
    expect(await caps.can({ role: 'contributor' }, 'publish_posts')).toBe(false);
    expect(await caps.can({ role: 'author' }, 'publish_posts')).toBe(true);
    expect(await caps.can({ role: 'author' }, 'edit_others_posts')).toBe(false);
    expect(await caps.can({ role: 'editor' }, 'edit_others_posts')).toBe(true);
  });
});

describe('can()', () => {
  it('denies anonymous visitors and unknown roles', async () => {
    const { caps } = setup();
    expect(await caps.can(null, 'read')).toBe(false);
    expect(await caps.can(undefined, 'read')).toBe(false);
    expect(await caps.can({ role: 'superuser' }, 'read')).toBe(false);
  });

  it('lets plugins add capabilities to a role', async () => {
    const { caps, hooks } = setup();
    hooks.addFilter('user:role-capabilities', (value, { role }) =>
      role === 'editor' ? [...value, 'manage_shop'] : value,
    );
    expect(await caps.can({ role: 'editor' }, 'manage_shop')).toBe(true);
    expect(await caps.can({ role: 'author' }, 'manage_shop')).toBe(false);
    expect(await caps.forRole('editor')).toContain('manage_shop');
  });

  it('lets a plugin grant a capability to an unknown custom role', async () => {
    const { caps, hooks } = setup();
    hooks.addFilter('user:role-capabilities', (value, { role }) =>
      role === 'shop_manager' ? [...value, 'manage_shop'] : value,
    );
    expect(await caps.can({ role: 'shop_manager' }, 'manage_shop')).toBe(true);
  });

  it('lets user:can override the built-in answer per user', async () => {
    const { caps, hooks } = setup();
    hooks.addFilter('user:can', (value, { user, capability }) =>
      user.id === 7 && capability === 'edit_posts' ? true : value,
    );
    expect(await caps.can({ id: 7, role: 'subscriber' }, 'edit_posts')).toBe(true);
    expect(await caps.can({ id: 8, role: 'subscriber' }, 'edit_posts')).toBe(false);
  });

  it('survives a failing filter', async () => {
    const { caps, hooks } = setup();
    hooks.addFilter('user:role-capabilities', () => {
      throw new Error('boom');
    });
    expect(await caps.can({ role: 'author' }, 'publish_posts')).toBe(true);
  });
});
