import { randomBytes } from 'node:crypto';
import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';
import { isSafeMenuUrl, type Menu, type MenuItem } from './menus.js';
import type { OptionsService } from './options.js';

declare module './options.js' {
  interface OptionMap {
    /** Widgets per theme widget area: area name → ordered widgets (see `WidgetService`). */
    widgets: Record<string, WidgetInstance[]>;
  }
}

declare module './hooks.js' {
  interface FilterMap {
    /**
     * The widget types plugins add. Return the list with your definitions appended (plugins
     * normally call `context.registerWidget()`, which does this and removes it on deactivation).
     */
    'widget:types': { value: WidgetTypeDefinition[]; context: undefined };
  }
}

export const MAX_WIDGETS_PER_AREA = 20;
export const MAX_WIDGET_TITLE_LENGTH = 100;
export const MAX_TEXT_WIDGET_LENGTH = 2000;
export const MAX_RECENT_POSTS = 20;
const DEFAULT_RECENT_POSTS = 5;
const TYPE_NAME = /^[a-z][a-z0-9]*(?:[-:/][a-z0-9]+)*$/;
const WIDGET_ID = /^[a-z0-9_-]{1,40}$/i;

/** A widget placed in an area. `settings` have been checked by its type. */
export interface WidgetInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
}

/** A setting of a widget type, as the admin draws it. `menu` is a choice among the site's menus. */
export interface WidgetField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'menu';
  required?: boolean;
  min?: number;
  max?: number;
}

export interface WidgetRenderContext {
  /** Look up a menu by id. */
  getMenu(id: number): Promise<Menu | undefined>;
  /** The latest published posts with their URLs. */
  recentPosts(limit: number): Promise<Array<{ title: string; url: string }>>;
}

export interface WidgetTypeDefinition {
  /** Unique name; plugins should prefix theirs, e.g. `shop/cart`. */
  type: string;
  title: string;
  description?: string;
  fields: WidgetField[];
  /**
   * Check and clean the settings: return only the settings the widget uses, or throw an Error
   * with a message a person can act on.
   */
  parse(settings: Record<string, unknown>): Record<string, unknown>;
  /** Return trusted HTML. Everything user-controlled must be escaped. */
  render(settings: Record<string, unknown>, context: WidgetRenderContext): string | Promise<string>;
}

/** A widget type as the API lists it (without code). */
export interface WidgetTypeInfo {
  type: string;
  title: string;
  description?: string;
  fields: WidgetField[];
}

/** A widget ready for a template: its HTML plus the heading it asked for. */
export interface RenderedWidget {
  id: string;
  type: string;
  title?: string;
  html: string;
}

/** Widget input was refused; `field` says where (for example `sidebar[1].settings.count`). */
export class WidgetValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'WidgetValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function optionalTitle(settings: Record<string, unknown>): Record<string, unknown> {
  const title = settings['title'];
  if (title === undefined || title === null || title === '') return {};
  if (typeof title !== 'string' || CONTROL.test(title)) throw new Error('title must be text');
  const trimmed = title.trim();
  if (trimmed.length > MAX_WIDGET_TITLE_LENGTH) {
    throw new Error(`title can be at most ${MAX_WIDGET_TITLE_LENGTH} characters`);
  }
  return trimmed === '' ? {} : { title: trimmed };
}

function menuHtml(items: readonly MenuItem[]): string {
  if (items.length === 0) return '';
  const lis = items.map((item) => {
    const external = item.target === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : '';
    const link = isSafeMenuUrl(item.url)
      ? `<a href="${escape(item.url)}"${external}>${escape(item.label)}</a>`
      : escape(item.label);
    return `<li>${link}${menuHtml(item.children)}</li>`;
  });
  return `<ul>${lis.join('')}</ul>`;
}

const textWidget: WidgetTypeDefinition = {
  type: 'text',
  title: 'Text',
  description: 'A short piece of plain text. Line breaks are kept; HTML is shown as typed.',
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'text', label: 'Text', type: 'textarea', required: true },
  ],
  parse(settings) {
    const text = settings['text'];
    if (typeof text !== 'string' || CONTROL.test(text) || text.trim() === '') {
      throw new Error('text is required');
    }
    if (text.length > MAX_TEXT_WIDGET_LENGTH) {
      throw new Error(`text can be at most ${MAX_TEXT_WIDGET_LENGTH} characters`);
    }
    return { ...optionalTitle(settings), text: text.trim() };
  },
  render(settings) {
    const text = typeof settings['text'] === 'string' ? settings['text'] : '';
    return text
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => `<p>${escape(paragraph.trim()).replace(/\r?\n/g, '<br>')}</p>`)
      .join('');
  },
};

const menuWidget: WidgetTypeDefinition = {
  type: 'menu',
  title: 'Menu',
  description: 'One of the site menus.',
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'menuId', label: 'Menu', type: 'menu', required: true },
  ],
  parse(settings) {
    const menuId = settings['menuId'];
    if (typeof menuId !== 'number' || !Number.isInteger(menuId) || menuId < 1) {
      throw new Error('menuId must be the id of a menu');
    }
    return { ...optionalTitle(settings), menuId };
  },
  async render(settings, context) {
    const menuId = settings['menuId'];
    const menu = typeof menuId === 'number' ? await context.getMenu(menuId) : undefined;
    return menu ? menuHtml(menu.items) : '';
  },
};

const recentPostsWidget: WidgetTypeDefinition = {
  type: 'recent-posts',
  title: 'Recent posts',
  description: 'Links to the latest published posts.',
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'count', label: 'Number of posts', type: 'number', min: 1, max: MAX_RECENT_POSTS },
  ],
  parse(settings) {
    const count = settings['count'] ?? DEFAULT_RECENT_POSTS;
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_RECENT_POSTS
    ) {
      throw new Error(`count must be a whole number from 1 to ${MAX_RECENT_POSTS}`);
    }
    return { ...optionalTitle(settings), count };
  },
  async render(settings, context) {
    const count = typeof settings['count'] === 'number' ? settings['count'] : DEFAULT_RECENT_POSTS;
    const posts = await context.recentPosts(count);
    if (posts.length === 0) return '';
    return `<ul>${posts
      .map((post) => `<li><a href="${escape(post.url)}">${escape(post.title)}</a></li>`)
      .join('')}</ul>`;
  },
};

const BUILT_IN = [textWidget, menuWidget, recentPostsWidget];

function validateDefinition(def: unknown): WidgetTypeDefinition {
  if (!isRecord(def)) throw new Error('a widget type must be an object');
  const { type, title, fields, parse, render } = def;
  if (typeof type !== 'string' || !TYPE_NAME.test(type) || type.length > 60) {
    throw new Error('a widget type needs a lowercase name such as "shop/cart"');
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error(`widget type "${type}" needs a title`);
  }
  if (!Array.isArray(fields)) throw new Error(`widget type "${type}" needs a fields list`);
  if (typeof parse !== 'function' || typeof render !== 'function') {
    throw new Error(`widget type "${type}" needs parse() and render()`);
  }
  return def as unknown as WidgetTypeDefinition;
}

export interface WidgetServiceOptions {
  options: OptionsService;
  hooks: HookRegistry;
  logger?: Logger;
  getMenu?: (id: number) => Promise<Menu | undefined>;
  recentPosts?: (limit: number) => Promise<Array<{ title: string; url: string }>>;
}

/**
 * Widgets and the theme areas they sit in. Which widgets are in each area (and their order) is
 * kept in the options table under `widgets`, so there is nothing to migrate. Types come from the
 * built-ins (`text`, `menu`, `recent-posts`) and from plugins through `registerWidget()`.
 *
 * A widget that cannot render (unknown type after a plugin was deactivated, or a throwing
 * `render()`) is left out of the page and logged; it never takes the page down.
 */
export class WidgetService {
  readonly #options: OptionsService;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #context: WidgetRenderContext;
  readonly #types = new Map<string, WidgetTypeDefinition>();
  readonly #fromFilter = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WidgetServiceOptions) {
    this.#options = options.options;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    this.#context = {
      getMenu: options.getMenu ?? (async () => undefined),
      recentPosts: options.recentPosts ?? (async () => []),
    };
    for (const def of BUILT_IN) this.#types.set(def.type, def);
  }

  /** Add a widget type. Throws for a malformed definition or a name that is already taken. */
  registerWidget(definition: WidgetTypeDefinition): void {
    const def = validateDefinition(definition);
    if (this.#types.has(def.type)) throw new Error(`widget type "${def.type}" already exists`);
    this.#types.set(def.type, def);
  }

  /**
   * Pick up the types plugins added through the `widget:types` filter. A bad or duplicate
   * definition is logged and skipped. Types added with `registerWidget()` stay.
   */
  async refresh(): Promise<void> {
    let found: unknown;
    try {
      found = await this.#hooks.applyFilters('widget:types', []);
    } catch (error) {
      this.#logger.error('widget:types filter failed', { error: String(error) });
      return;
    }
    if (!Array.isArray(found)) {
      this.#logger.warn('widget:types must return an array; ignoring');
      return;
    }
    // Types a plugin contributed earlier go first, so a deactivated plugin's widgets disappear.
    for (const type of this.#fromFilter) this.#types.delete(type);
    this.#fromFilter.clear();
    for (const raw of found) {
      try {
        const def = validateDefinition(raw);
        if (this.#types.has(def.type)) throw new Error(`widget type "${def.type}" already exists`);
        this.#types.set(def.type, def);
        this.#fromFilter.add(def.type);
      } catch (error) {
        this.#logger.warn(`Widget type skipped: ${(error as Error).message}`);
      }
    }
  }

  types(): WidgetTypeInfo[] {
    return [...this.#types.values()].map((def) => ({
      type: def.type,
      title: def.title,
      ...(def.description ? { description: def.description } : {}),
      fields: def.fields,
    }));
  }

  async #read(): Promise<Record<string, WidgetInstance[]>> {
    const stored = await this.#options.get('widgets');
    return isRecord(stored) ? (stored as Record<string, WidgetInstance[]>) : {};
  }

  /** The widgets of each of `areas` (an area with none is an empty list). */
  async getAreas(areas: readonly string[]): Promise<Record<string, WidgetInstance[]>> {
    const stored = await this.#read();
    const result: Record<string, WidgetInstance[]> = {};
    for (const area of areas) {
      const list = stored[area];
      result[area] = Array.isArray(list) ? list : [];
    }
    return result;
  }

  /**
   * Replace the widgets of the areas named in `input` (`{ sidebar: [{ type, settings }] }`); areas
   * not mentioned are kept. Only `knownAreas` (the active theme's) are accepted. Each widget
   * gets an id if it has none. Nothing is saved when anything is refused.
   */
  async setAreas(
    input: Record<string, unknown>,
    knownAreas: readonly string[],
  ): Promise<Record<string, WidgetInstance[]>> {
    const parsed: Record<string, WidgetInstance[]> = {};
    for (const [area, value] of Object.entries(input)) {
      if (!knownAreas.includes(area)) {
        throw new WidgetValidationError(area, `"${area}" is not a widget area of the theme`);
      }
      if (!Array.isArray(value)) {
        throw new WidgetValidationError(area, `${area} must be a list of widgets`);
      }
      if (value.length > MAX_WIDGETS_PER_AREA) {
        throw new WidgetValidationError(
          area,
          `an area can have at most ${MAX_WIDGETS_PER_AREA} widgets`,
        );
      }
      const seen = new Set<string>();
      parsed[area] = value.map((raw: unknown, index) => {
        const at = `${area}[${index}]`;
        if (!isRecord(raw)) throw new WidgetValidationError(at, `${at} must be an object`);
        const def = typeof raw['type'] === 'string' ? this.#types.get(raw['type']) : undefined;
        if (!def) {
          throw new WidgetValidationError(`${at}.type`, `unknown widget type`);
        }
        const rawSettings = raw['settings'] ?? {};
        if (!isRecord(rawSettings)) {
          throw new WidgetValidationError(`${at}.settings`, 'settings must be an object');
        }
        let settings: Record<string, unknown>;
        try {
          settings = def.parse(rawSettings);
        } catch (error) {
          throw new WidgetValidationError(
            `${at}.settings`,
            error instanceof Error ? error.message : 'invalid settings',
          );
        }
        let id = raw['id'];
        if (id === undefined) {
          id = `w_${randomBytes(6).toString('hex')}`;
        } else if (typeof id !== 'string' || !WIDGET_ID.test(id)) {
          throw new WidgetValidationError(`${at}.id`, 'id must be letters, digits, - or _');
        }
        if (seen.has(id as string)) {
          throw new WidgetValidationError(`${at}.id`, 'ids must be unique within an area');
        }
        seen.add(id as string);
        return { id: id as string, type: def.type, settings };
      });
    }
    const run = this.#queue.then(async () => {
      const stored = await this.#read();
      const next = { ...stored, ...parsed };
      await this.#options.set('widgets', next);
      return this.getAreas(knownAreas);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The widgets of each of `areas`, rendered for a template. Failing widgets are skipped. */
  async forAreas(areas: readonly string[]): Promise<Record<string, RenderedWidget[]>> {
    const stored = await this.getAreas(areas);
    const result: Record<string, RenderedWidget[]> = {};
    for (const area of areas) {
      const rendered: RenderedWidget[] = [];
      for (const widget of stored[area] ?? []) {
        const def = this.#types.get(widget.type);
        if (!def) {
          this.#logger.warn(`Widget ${widget.id} skipped: type "${widget.type}" is not available`);
          continue;
        }
        try {
          const html = await def.render(widget.settings, this.#context);
          if (typeof html !== 'string') throw new Error('render() must return a string');
          const title = widget.settings['title'];
          rendered.push({
            id: widget.id,
            type: widget.type,
            ...(typeof title === 'string' && title !== '' ? { title } : {}),
            html,
          });
        } catch (error) {
          this.#logger.warn(`Widget ${widget.id} (${widget.type}) failed: ${String(error)}`);
        }
      }
      result[area] = rendered;
    }
    return result;
  }
}

export function createWidgetService(options: WidgetServiceOptions): WidgetService {
  return new WidgetService(options);
}
