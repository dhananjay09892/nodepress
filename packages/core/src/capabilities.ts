import type { HookRegistry } from './hooks.js';

export const ROLES = ['administrator', 'editor', 'author', 'contributor', 'subscriber'] as const;
export type RoleName = (typeof ROLES)[number];

declare module './hooks.js' {
  interface FilterMap {
    /**
     * The capability list of a role. Plugins add (or remove) capabilities here; the result is
     * what `can()` uses. Context carries the role name.
     */
    'user:role-capabilities': { value: string[]; context: { role: string } };
    /**
     * Final say on a capability check. `value` is the built-in answer; return a boolean to
     * override it (for example to grant a capability per user).
     */
    'user:can': { value: boolean; context: { user: CapabilityUser; capability: string } };
  }
}

/** The part of a user that permission checks need. */
export interface CapabilityUser {
  id?: number;
  role: string;
}

const SUBSCRIBER = ['read'];
const CONTRIBUTOR = [...SUBSCRIBER, 'edit_posts', 'delete_posts'];
const AUTHOR = [
  ...CONTRIBUTOR,
  'publish_posts',
  'edit_published_posts',
  'delete_published_posts',
  'upload_files',
];
const EDITOR = [
  ...AUTHOR,
  'edit_others_posts',
  'delete_others_posts',
  'edit_pages',
  'edit_others_pages',
  'publish_pages',
  'delete_pages',
  'delete_others_pages',
  'manage_categories',
  'moderate_comments',
  'read_private_posts',
];
const ADMINISTRATOR = [
  ...EDITOR,
  'manage_options',
  'manage_plugins',
  'manage_themes',
  'list_users',
  'create_users',
  'edit_users',
  'delete_users',
  'promote_users',
];

/** Built-in capabilities per role. Each role includes everything the one below it has. */
export const DEFAULT_ROLE_CAPABILITIES: Readonly<Record<RoleName, readonly string[]>> = {
  administrator: [...new Set(ADMINISTRATOR)],
  editor: [...new Set(EDITOR)],
  author: [...new Set(AUTHOR)],
  contributor: [...new Set(CONTRIBUTOR)],
  subscriber: [...new Set(SUBSCRIBER)],
};

export function isRole(value: string): value is RoleName {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Role to capability map with plugin extension. Unknown roles have no capabilities, so a bad
 * value in the database never grants access.
 */
export class Capabilities {
  readonly #hooks: HookRegistry;

  constructor(hooks: HookRegistry) {
    this.#hooks = hooks;
  }

  /** Capabilities of a role after the `user:role-capabilities` filter. */
  async forRole(role: string): Promise<string[]> {
    const base = isRole(role) ? [...DEFAULT_ROLE_CAPABILITIES[role]] : [];
    const filtered = await this.#hooks.applyFilters('user:role-capabilities', base, { role });
    return Array.isArray(filtered) ? filtered.filter((c) => typeof c === 'string') : base;
  }

  /** Does `user` hold `capability`? A missing user (anonymous visitor) never does. */
  async can(user: CapabilityUser | null | undefined, capability: string): Promise<boolean> {
    if (!user) return false;
    const builtIn = (await this.forRole(user.role)).includes(capability);
    const result = await this.#hooks.applyFilters('user:can', builtIn, { user, capability });
    return typeof result === 'boolean' ? result : builtIn;
  }
}

export function createCapabilities(hooks: HookRegistry): Capabilities {
  return new Capabilities(hooks);
}
