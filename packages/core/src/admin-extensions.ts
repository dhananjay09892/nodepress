import { parseFieldDefinition, validateFieldValues, ContentTypeError } from './content-types.js';
import type { FieldDefinition, FieldIssue } from './content-types.js';
import { scopeHooks, type HookRegistry } from './hooks.js';
import type { Logger } from './logger.js';
import type { OptionsService } from './options.js';

/** Field types a settings panel can show. Rich text, media and relations need richer inputs. */
export const PANEL_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select'] as const;
export type PanelFieldType = (typeof PANEL_FIELD_TYPES)[number];
export type PanelField = Extract<FieldDefinition, { type: PanelFieldType }>;

export const MAX_PANELS_PER_PAGE = 20;
export const MAX_FIELDS_PER_PANEL = 50;
export const MAX_PAGES_PER_PLUGIN = 20;
export const MAX_MENU_ITEMS_PER_PLUGIN = 20;

const ID_PATTERN = /^[a-z][a-z0-9-]{0,49}$/;

/** A group of settings shown on a plugin page. Values are stored in the options table. */
export interface AdminPanelDefinition {
  /** Lower-case id, unique within the page. */
  id: string;
  title: string;
  description?: string;
  fields: PanelField[];
}

/** A page a plugin adds to the admin. Today a page is made of settings panels. */
export interface AdminPageDefinition {
  /** Lower-case id, unique within the plugin; part of the page's URL. */
  id: string;
  title: string;
  description?: string;
  /**
   * Capability needed to see and use the page. Defaults to `manage_options`, so a plugin page
   * is administrator-only unless the plugin says otherwise.
   */
  capability?: string;
  panels: AdminPanelDefinition[];
}

/** A link in the admin sidebar that opens one of the plugin's pages. */
export interface AdminMenuItemDefinition {
  id: string;
  label: string;
  /** Id of a page added by the same plugin. The item is hidden for people who cannot open it. */
  page: string;
  /** Lower numbers come first. Default 100; ties are broken by label. */
  order?: number;
}

/** A custom field shown in the post sidebar (stored with the post, validated by its type). */
export interface AdminPostFieldDefinition {
  /** Content types that get the field. Default: `post` and `page`. */
  contentTypes?: string[];
  field: FieldDefinition;
}

/** What `context.admin` gives a plugin. Everything added here is removed on deactivation. */
export interface ScopedAdmin {
  addPage(page: AdminPageDefinition): void;
  addMenuItem(item: AdminMenuItemDefinition): void;
  /** Add a custom field to content types; it shows in the post sidebar of the admin. */
  addPostField(definition: AdminPostFieldDefinition): void;
  /** The saved values of one settings panel, with defaults filled in. */
  getSettings(pageId: string, panelId: string): Promise<Record<string, unknown>>;
}

export class AdminExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminExtensionError';
  }
}

export class PanelValidationError extends Error {
  constructor(readonly issues: FieldIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    this.name = 'PanelValidationError';
  }
}

/** The menu and pages a person may use, as sent to the admin app. */
export interface AdminExtensionsView {
  menu: { plugin: string; id: string; label: string; page: string }[];
  pages: {
    plugin: string;
    id: string;
    title: string;
    description?: string;
    panels: AdminPanelDefinition[];
  }[];
}

interface PluginEntry {
  pages: Map<string, AdminPageDefinition>;
  menu: Map<string, AdminMenuItemDefinition>;
}

function checkId(kind: string, id: unknown): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new AdminExtensionError(
      `Invalid ${kind} id "${String(id)}" (use lower-case letters, digits and dashes, e.g. "my-page")`,
    );
  }
  return id;
}

function checkText(kind: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AdminExtensionError(
      `${kind} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

function optionalText(kind: string, value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new AdminExtensionError(`${kind} must be a string of at most ${max} characters`);
  }
  return value;
}

/** Validate and copy a page definition so later changes by the plugin cannot alter it. */
function parsePage(input: AdminPageDefinition): AdminPageDefinition {
  if (typeof input !== 'object' || input === null) {
    throw new AdminExtensionError('A page must be an object');
  }
  const id = checkId('page', input.id);
  const title = checkText('Page title', input.title, 100);
  const description = optionalText('Page description', input.description, 500);
  const capability = optionalText('Page capability', input.capability, 100);
  if (capability !== undefined && capability === '') {
    throw new AdminExtensionError('Page capability cannot be empty');
  }
  if (!Array.isArray(input.panels) || input.panels.length === 0) {
    throw new AdminExtensionError(`Page "${id}" needs at least one panel`);
  }
  if (input.panels.length > MAX_PANELS_PER_PAGE) {
    throw new AdminExtensionError(`Page "${id}" has more than ${MAX_PANELS_PER_PAGE} panels`);
  }
  const seenPanels = new Set<string>();
  const panels = input.panels.map((panel): AdminPanelDefinition => {
    const panelId = checkId('panel', panel?.id);
    if (seenPanels.has(panelId)) {
      throw new AdminExtensionError(`Page "${id}" has two panels called "${panelId}"`);
    }
    seenPanels.add(panelId);
    const panelTitle = checkText('Panel title', panel.title, 100);
    const panelDescription = optionalText('Panel description', panel.description, 500);
    if (
      !Array.isArray(panel.fields) ||
      panel.fields.length === 0 ||
      panel.fields.length > MAX_FIELDS_PER_PANEL
    ) {
      throw new AdminExtensionError(
        `Panel "${panelId}" needs between 1 and ${MAX_FIELDS_PER_PANEL} fields`,
      );
    }
    const seenFields = new Set<string>();
    const fields = panel.fields.map((candidate) => {
      let field: FieldDefinition;
      try {
        field = parseFieldDefinition(candidate);
      } catch (error) {
        throw new AdminExtensionError(
          `Panel "${panelId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!(PANEL_FIELD_TYPES as readonly string[]).includes(field.type)) {
        throw new AdminExtensionError(
          `Panel "${panelId}": field "${field.name}" has type "${field.type}"; use one of ${PANEL_FIELD_TYPES.join(', ')}`,
        );
      }
      if (seenFields.has(field.name)) {
        throw new AdminExtensionError(`Panel "${panelId}" has two fields called "${field.name}"`);
      }
      seenFields.add(field.name);
      return field as PanelField;
    });
    return {
      id: panelId,
      title: panelTitle,
      ...(panelDescription !== undefined ? { description: panelDescription } : {}),
      fields,
    };
  });
  return {
    id,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(capability !== undefined ? { capability } : {}),
    panels,
  };
}

export interface AdminExtensionsOptions {
  hooks: HookRegistry;
  logger?: Logger;
}

/**
 * What plugins add to the admin: sidebar menu items, pages made of settings panels and custom
 * post fields. It only holds declarations; the admin app draws them, so a plugin never runs
 * code in the browser and a broken plugin cannot break the admin.
 *
 * Panel values live in the `options` table under `admin-ext:<plugin>:<page>:<panel>`, are
 * validated with the same rules as content fields, and are never autoloaded.
 */
export class AdminExtensions {
  #plugins = new Map<string, PluginEntry>();
  #hooks: HookRegistry;
  #options: OptionsService | undefined;

  constructor(options: AdminExtensionsOptions) {
    this.#hooks = options.hooks;
  }

  /** Give the registry somewhere to store panel values. Call once the options service exists. */
  useOptions(options: OptionsService): void {
    this.#options = options;
  }

  /** The `context.admin` of one plugin. */
  scoped(plugin: string): ScopedAdmin {
    return {
      addPage: (page) => this.#addPage(plugin, page),
      addMenuItem: (item) => this.#addMenuItem(plugin, item),
      addPostField: (definition) => this.#addPostField(plugin, definition),
      getSettings: (pageId, panelId) => this.readPanel(plugin, pageId, panelId),
    };
  }

  /** Forget everything a plugin added (its post fields go with its hooks). */
  removeAllFromSource(plugin: string): void {
    this.#plugins.delete(plugin);
  }

  /**
   * The menu items and pages `can` allows, in menu order. A page whose capability the person
   * lacks is left out entirely, with its menu items.
   */
  async describe(can: (capability: string) => Promise<boolean>): Promise<AdminExtensionsView> {
    const view: AdminExtensionsView = { menu: [], pages: [] };
    const ordered: { order: number; label: string; item: AdminExtensionsView['menu'][number] }[] =
      [];
    for (const [plugin, entry] of this.#plugins) {
      const allowed = new Set<string>();
      for (const page of entry.pages.values()) {
        if (!(await can(page.capability ?? 'manage_options'))) continue;
        allowed.add(page.id);
        view.pages.push({
          plugin,
          id: page.id,
          title: page.title,
          ...(page.description !== undefined ? { description: page.description } : {}),
          panels: page.panels,
        });
      }
      for (const item of entry.menu.values()) {
        if (!allowed.has(item.page)) continue;
        ordered.push({
          order: item.order ?? 100,
          label: item.label,
          item: { plugin, id: item.id, label: item.label, page: item.page },
        });
      }
    }
    ordered.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    view.menu = ordered.map((o) => o.item);
    return view;
  }

  /** The page (with its capability) or `undefined` when the plugin or page is not registered. */
  getPage(plugin: string, pageId: string): AdminPageDefinition | undefined {
    return this.#plugins.get(plugin)?.pages.get(pageId);
  }

  /** The saved values of a panel with defaults filled in. Throws if the panel is unknown. */
  async readPanel(
    plugin: string,
    pageId: string,
    panelId: string,
  ): Promise<Record<string, unknown>> {
    const panel = this.#panel(plugin, pageId, panelId);
    const stored = this.#options
      ? await this.#options.get(optionKey(plugin, pageId, panelId), {})
      : {};
    const base = validateFieldValues(panel.fields, {});
    const defaults = base.ok ? base.value : {};
    const values: Record<string, unknown> = { ...defaults };
    const known = new Set(panel.fields.map((f) => f.name));
    if (typeof stored === 'object' && stored !== null) {
      for (const [key, value] of Object.entries(stored)) if (known.has(key)) values[key] = value;
    }
    return values;
  }

  /**
   * Save some fields of a panel. Only the fields sent change; `null` clears one back to its
   * default. Throws PanelValidationError (nothing saved) when a value is invalid.
   */
  async writePanel(
    plugin: string,
    pageId: string,
    panelId: string,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.#options) throw new AdminExtensionError('Settings storage is not available');
    const panel = this.#panel(plugin, pageId, panelId);
    const checked = validateFieldValues(panel.fields, input, { partial: true });
    if (!checked.ok) throw new PanelValidationError(checked.issues);
    const key = optionKey(plugin, pageId, panelId);
    const stored = await this.#options.get(key, {});
    const next: Record<string, unknown> =
      typeof stored === 'object' && stored !== null && !Array.isArray(stored)
        ? { ...(stored as Record<string, unknown>) }
        : {};
    for (const [name, value] of Object.entries(checked.value)) {
      if (value === null || value === undefined) delete next[name];
      else next[name] = value;
    }
    await this.#options.set(key, next, { autoload: false });
    return this.readPanel(plugin, pageId, panelId);
  }

  #panel(plugin: string, pageId: string, panelId: string): AdminPanelDefinition {
    const page = this.getPage(plugin, pageId);
    const panel = page?.panels.find((p) => p.id === panelId);
    if (!panel) throw new AdminExtensionError(`Unknown settings panel ${pageId}/${panelId}`);
    return panel;
  }

  #entry(plugin: string): PluginEntry {
    let entry = this.#plugins.get(plugin);
    if (!entry) {
      entry = { pages: new Map(), menu: new Map() };
      this.#plugins.set(plugin, entry);
    }
    return entry;
  }

  #addPage(plugin: string, input: AdminPageDefinition): void {
    const page = parsePage(input);
    const entry = this.#entry(plugin);
    if (entry.pages.has(page.id)) {
      throw new AdminExtensionError(`Plugin "${plugin}" already has a page "${page.id}"`);
    }
    if (entry.pages.size >= MAX_PAGES_PER_PLUGIN) {
      throw new AdminExtensionError(`A plugin can add at most ${MAX_PAGES_PER_PLUGIN} pages`);
    }
    entry.pages.set(page.id, page);
  }

  #addMenuItem(plugin: string, input: AdminMenuItemDefinition): void {
    if (typeof input !== 'object' || input === null) {
      throw new AdminExtensionError('A menu item must be an object');
    }
    const item: AdminMenuItemDefinition = {
      id: checkId('menu item', input.id),
      label: checkText('Menu label', input.label, 40),
      page: checkId('page', input.page),
      ...(input.order !== undefined
        ? { order: Number.isFinite(input.order) ? input.order : 100 }
        : {}),
    };
    const entry = this.#entry(plugin);
    if (entry.menu.has(item.id)) {
      throw new AdminExtensionError(`Plugin "${plugin}" already has a menu item "${item.id}"`);
    }
    if (entry.menu.size >= MAX_MENU_ITEMS_PER_PLUGIN) {
      throw new AdminExtensionError(
        `A plugin can add at most ${MAX_MENU_ITEMS_PER_PLUGIN} menu items`,
      );
    }
    entry.menu.set(item.id, item);
  }

  #addPostField(plugin: string, input: AdminPostFieldDefinition): void {
    if (typeof input !== 'object' || input === null) {
      throw new AdminExtensionError('A post field must be an object');
    }
    let field: FieldDefinition;
    try {
      field = parseFieldDefinition(input.field);
    } catch (error) {
      if (error instanceof ContentTypeError) throw new AdminExtensionError(error.message);
      throw error;
    }
    const types = input.contentTypes ?? ['post', 'page'];
    if (!Array.isArray(types) || types.length === 0 || types.some((t) => typeof t !== 'string')) {
      throw new AdminExtensionError('contentTypes must be a non-empty list of type names');
    }
    const wanted = new Set(types);
    // Listeners carry the plugin name as their source, so deactivating the plugin removes them.
    scopeHooks(this.#hooks, plugin).addFilter('content-type:fields', (fields, context) =>
      wanted.has(context.type) ? [...fields, field] : fields,
    );
  }
}

function optionKey(plugin: string, pageId: string, panelId: string): string {
  return `admin-ext:${plugin}:${pageId}:${panelId}`;
}
