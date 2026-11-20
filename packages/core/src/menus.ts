import type { OptionsService } from './options.js';

declare module './options.js' {
  interface OptionMap {
    /** All navigation menus (see `MenuService`). */
    menus: StoredMenus;
    /** Which menu is shown at each theme menu location: location name → menu id. */
    menu_locations: Record<string, number>;
  }
}

export const MAX_MENUS = 50;
export const MAX_MENU_NAME_LENGTH = 100;
export const MAX_MENU_ITEMS = 200;
export const MAX_MENU_DEPTH = 3;
export const MAX_ITEM_LABEL_LENGTH = 100;
export const MAX_ITEM_URL_LENGTH = 2000;

/** One link in a menu, with the links nested under it. */
export interface MenuItem {
  label: string;
  /** A site path (`/about`), an `http(s)` URL, `mailto:` or `tel:`. */
  url: string;
  /** `_blank` opens the link in a new tab. */
  target?: '_blank';
  children: MenuItem[];
}

export interface Menu {
  id: number;
  name: string;
  items: MenuItem[];
}

/** What `menus` holds in the options table. */
export interface StoredMenus {
  nextId: number;
  menus: Menu[];
}

/** Menu input was refused; `field` says where (for example `items[1].children[0].url`). */
export class MenuValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'MenuValidationError';
  }
}

export class MenuNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`Menu ${id} does not exist`);
    this.name = 'MenuNotFoundError';
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_SCHEME = /^(?:https?:\/\/[^\s/?#]+|mailto:[^\s]+|tel:[+0-9().\s-]+$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `url` is safe to put in a link: a path on this site (not protocol-relative), an
 * `http(s)` URL, `mailto:` or `tel:`. Anything else (`javascript:`, `data:`) is refused.
 */
export function isSafeMenuUrl(url: string): boolean {
  if (url === '' || url.length > MAX_ITEM_URL_LENGTH || CONTROL_CHARACTERS.test(url)) return false;
  if (/\s/.test(url) && !url.toLowerCase().startsWith('tel:')) return false;
  if (url.startsWith('/')) return !url.startsWith('//') && !url.includes('\\');
  return SAFE_SCHEME.test(url);
}

function parseName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string') throw new MenuValidationError(field, `${field} must be a string`);
  const name = value.trim();
  if (name === '' || name.length > MAX_MENU_NAME_LENGTH || CONTROL_CHARACTERS.test(name)) {
    throw new MenuValidationError(field, `${field} must be 1 to ${MAX_MENU_NAME_LENGTH} characters`);
  }
  return name;
}

/**
 * Validate and clean a list of menu items (unknown properties are dropped). Throws
 * `MenuValidationError` naming the first bad field.
 */
export function parseMenuItems(value: unknown, field = 'items'): MenuItem[] {
  let count = 0;
  const walk = (list: unknown, path: string, depth: number): MenuItem[] => {
    if (!Array.isArray(list)) throw new MenuValidationError(path, `${path} must be a list`);
    if (depth > MAX_MENU_DEPTH && list.length > 0) {
      throw new MenuValidationError(path, `menus can be at most ${MAX_MENU_DEPTH} levels deep`);
    }
    return list.map((raw: unknown, index) => {
      const at = `${path}[${index}]`;
      if (++count > MAX_MENU_ITEMS) {
        throw new MenuValidationError(field, `a menu can have at most ${MAX_MENU_ITEMS} items`);
      }
      if (!isRecord(raw)) throw new MenuValidationError(at, `${at} must be an object`);
      const { label, url, target, children } = raw;
      if (
        typeof label !== 'string' ||
        label.trim() === '' ||
        label.length > MAX_ITEM_LABEL_LENGTH ||
        CONTROL_CHARACTERS.test(label)
      ) {
        throw new MenuValidationError(
          `${at}.label`,
          `label must be 1 to ${MAX_ITEM_LABEL_LENGTH} characters`,
        );
      }
      if (typeof url !== 'string' || !isSafeMenuUrl(url)) {
        throw new MenuValidationError(
          `${at}.url`,
          'url must be a site path, an http(s) URL, mailto: or tel:',
        );
      }
      if (target !== undefined && target !== '_blank') {
        throw new MenuValidationError(`${at}.target`, 'target must be "_blank" or left out');
      }
      return {
        label: label.trim(),
        url,
        ...(target === '_blank' ? { target: '_blank' as const } : {}),
        children: walk(children ?? [], `${at}.children`, depth + 1),
      };
    });
  };
  return walk(value, field, 1);
}

export interface MenuServiceOptions {
  options: OptionsService;
}

const EMPTY: StoredMenus = { nextId: 1, menus: [] };

/**
 * Navigation menus and where themes show them. Menus and their location assignments are kept
 * in the options table (`menus`, `menu_locations`), so there is nothing to migrate.
 *
 * Writes are queued, so two requests in one process cannot overwrite each other's change.
 */
export class MenuService {
  readonly #options: OptionsService;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: MenuServiceOptions) {
    this.#options = options.options;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<StoredMenus> {
    const stored = await this.#options.get('menus');
    return stored && Array.isArray(stored.menus) ? stored : structuredClone(EMPTY);
  }

  async list(): Promise<Menu[]> {
    return (await this.#read()).menus;
  }

  async get(id: number): Promise<Menu | undefined> {
    return (await this.#read()).menus.find((menu) => menu.id === id);
  }

  async create(input: { name: unknown; items?: unknown }): Promise<Menu> {
    const name = parseName(input.name);
    const items = parseMenuItems(input.items ?? []);
    return this.#serial(async () => {
      const stored = await this.#read();
      if (stored.menus.length >= MAX_MENUS) {
        throw new MenuValidationError('name', `a site can have at most ${MAX_MENUS} menus`);
      }
      const menu: Menu = { id: stored.nextId, name, items };
      await this.#options.set('menus', {
        nextId: stored.nextId + 1,
        menus: [...stored.menus, menu],
      });
      return menu;
    });
  }

  /** Rename a menu and/or replace its items. Throws `MenuNotFoundError`. */
  async update(id: number, input: { name?: unknown; items?: unknown }): Promise<Menu> {
    const name = input.name === undefined ? undefined : parseName(input.name);
    const items = input.items === undefined ? undefined : parseMenuItems(input.items);
    return this.#serial(async () => {
      const stored = await this.#read();
      const current = stored.menus.find((menu) => menu.id === id);
      if (!current) throw new MenuNotFoundError(id);
      const next: Menu = { id, name: name ?? current.name, items: items ?? current.items };
      await this.#options.set('menus', {
        nextId: stored.nextId,
        menus: stored.menus.map((menu) => (menu.id === id ? next : menu)),
      });
      return next;
    });
  }

  /** Delete a menu and free the locations it was assigned to. Returns false if it did not exist. */
  async delete(id: number): Promise<boolean> {
    return this.#serial(async () => {
      const stored = await this.#read();
      if (!stored.menus.some((menu) => menu.id === id)) return false;
      await this.#options.set('menus', {
        nextId: stored.nextId,
        menus: stored.menus.filter((menu) => menu.id !== id),
      });
      const locations = await this.getLocations();
      const kept = Object.entries(locations).filter(([, menuId]) => menuId !== id);
      if (kept.length !== Object.keys(locations).length) {
        await this.#options.set('menu_locations', Object.fromEntries(kept));
      }
      return true;
    });
  }

  /** The assigned menu id per location (locations with no menu are absent). */
  async getLocations(): Promise<Record<string, number>> {
    const stored = await this.#options.get('menu_locations');
    return isRecord(stored) ? { ...(stored as Record<string, number>) } : {};
  }

  /**
   * Assign menus to locations. `assignments` maps a location to a menu id, or to `null` to
   * clear it; locations not mentioned are kept. Only `knownLocations` (the active theme's)
   * are accepted. Returns all assignments.
   */
  async setLocations(
    assignments: Record<string, unknown>,
    knownLocations: readonly string[],
  ): Promise<Record<string, number>> {
    for (const [location, value] of Object.entries(assignments)) {
      if (!knownLocations.includes(location)) {
        throw new MenuValidationError(location, `"${location}" is not a menu location of the theme`);
      }
      if (value !== null && (typeof value !== 'number' || !Number.isInteger(value))) {
        throw new MenuValidationError(location, `${location} must be a menu id or null`);
      }
    }
    return this.#serial(async () => {
      const { menus } = await this.#read();
      const result = await this.getLocations();
      for (const [location, value] of Object.entries(assignments)) {
        if (value === null) {
          delete result[location];
        } else if (menus.some((menu) => menu.id === value)) {
          result[location] = value as number;
        } else {
          throw new MenuValidationError(location, `menu ${String(value)} does not exist`);
        }
      }
      await this.#options.set('menu_locations', result);
      return result;
    });
  }

  /** The menu items for each of `locations` that has a menu assigned. */
  async forLocations(locations: readonly string[]): Promise<Record<string, MenuItem[]>> {
    const [assigned, stored] = await Promise.all([this.getLocations(), this.#read()]);
    const result: Record<string, MenuItem[]> = {};
    for (const location of locations) {
      const menu = stored.menus.find((m) => m.id === assigned[location]);
      if (menu) result[location] = menu.items;
    }
    return result;
  }
}

export function createMenuService(options: MenuServiceOptions): MenuService {
  return new MenuService(options);
}
