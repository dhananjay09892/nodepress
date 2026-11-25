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

/** A number shown above a report, read from `data.totals[key]` of the report route's answer. */
export interface AdminReportTotal {
  key: string;
  label: string;
}

/** A column of a report table: a key of each row. */
export interface AdminReportColumn {
  key: string;
  label: string;
  /** Right-aligned, shown with thousands separators. */
  numeric?: boolean;
}

/** A table drawn from an array in the report route's answer. */
export interface AdminReportTable {
  /** Key of an array of rows in the answer. */
  rows: string;
  title: string;
  columns: AdminReportColumn[];
}

/** A bar chart of one or more series over time, always with a table as a text alternative. */
export interface AdminReportChart {
  title: string;
  /** Key of an array of rows in the answer. */
  rows: string;
  /** Key of the row's label (a `YYYY-MM-DD` day). */
  x: string;
  series: { key: string; label: string }[];
}

/**
 * A read-only page of numbers a plugin serves from one of its own routes. The admin asks
 * `GET /api/v1/plugins/<plugin><route>?from=YYYY-MM-DD&to=YYYY-MM-DD` and draws the answer, so
 * the plugin describes the report and never runs code in the browser.
 */
export interface AdminReportDefinition {
  /** The plugin route that answers JSON, for example `/summary`. */
  route: string;
  /** Days the date range covers when the page opens. Default 30. */
  defaultDays?: number;
  /** Longest range the route accepts; the date picker keeps to it. Default 366. */
  maxDays?: number;
  totals?: AdminReportTotal[];
  chart?: AdminReportChart;
  tables?: AdminReportTable[];
}

/** A page a plugin adds to the admin: settings panels, a report, or both. */
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
  /** Settings panels. May be empty when the page has a `report`. */
  panels: AdminPanelDefinition[];
  report?: AdminReportDefinition;
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
    report?: AdminReportDefinition;
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

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,99}$/;

function checkKey(kind: string, value: unknown): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new AdminExtensionError(`${kind} must be a plain key such as "views"`);
  }
  return value;
}

function checkList<T>(kind: string, value: unknown, max: number): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new AdminExtensionError(`${kind} needs between 1 and ${max} entries`);
  }
  return value as T[];
}

function checkObject(kind: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdminExtensionError(`${kind} must be an object`);
  }
  return value as Record<string, unknown>;
}

function checkDays(kind: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3650) {
    throw new AdminExtensionError(`${kind} must be a whole number of days between 1 and 3650`);
  }
  return value;
}

/** Validate and copy a report definition; the page's data comes from a route of the plugin. */
function parseReport(input: unknown): AdminReportDefinition {
  const report = checkObject('report', input);
  const route = report['route'];
  if (typeof route !== 'string' || !ROUTE_PATTERN.test(route) || route.includes('..')) {
    throw new AdminExtensionError(
      'report.route must be a path of the plugin such as "/summary" (no query, no "..")',
    );
  }
  const maxDays = checkDays('report.maxDays', report['maxDays'], 366);
  const defaultDays = checkDays('report.defaultDays', report['defaultDays'], 30);
  if (defaultDays > maxDays) {
    throw new AdminExtensionError('report.defaultDays cannot be more than report.maxDays');
  }
  const parseColumns = (kind: string, value: unknown): AdminReportColumn[] =>
    checkList<unknown>(kind, value, 10).map((c) => {
      const column = checkObject(kind, c);
      return {
        key: checkKey(`${kind} key`, column['key']),
        label: checkText(`${kind} label`, column['label'], 60),
        ...(column['numeric'] === true ? { numeric: true } : {}),
      };
    });
  const totals =
    report['totals'] === undefined
      ? undefined
      : checkList<unknown>('report.totals', report['totals'], 6).map((t) => {
          const total = checkObject('report.totals entry', t);
          return {
            key: checkKey('report.totals key', total['key']),
            label: checkText('report.totals label', total['label'], 60),
          };
        });
  let chart: AdminReportChart | undefined;
  if (report['chart'] !== undefined) {
    const c = checkObject('report.chart', report['chart']);
    chart = {
      title: checkText('report.chart title', c['title'], 100),
      rows: checkKey('report.chart rows', c['rows']),
      x: checkKey('report.chart x', c['x']),
      series: checkList<unknown>('report.chart series', c['series'], 3).map((s) => {
        const series = checkObject('report.chart series entry', s);
        return {
          key: checkKey('report.chart series key', series['key']),
          label: checkText('report.chart series label', series['label'], 60),
        };
      }),
    };
  }
  const tables =
    report['tables'] === undefined
      ? undefined
      : checkList<unknown>('report.tables', report['tables'], 6).map((t): AdminReportTable => {
          const table = checkObject('report.tables entry', t);
          return {
            rows: checkKey('report.tables rows', table['rows']),
            title: checkText('report.tables title', table['title'], 100),
            columns: parseColumns('report.tables column', table['columns']),
          };
        });
  if (!totals && !chart && !tables) {
    throw new AdminExtensionError('A report needs totals, a chart or tables');
  }
  return {
    route,
    defaultDays,
    maxDays,
    ...(totals ? { totals } : {}),
    ...(chart ? { chart } : {}),
    ...(tables ? { tables } : {}),
  };
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
  const report = input.report === undefined ? undefined : parseReport(input.report);
  if (!Array.isArray(input.panels) || (input.panels.length === 0 && !report)) {
    throw new AdminExtensionError(`Page "${id}" needs at least one panel or a report`);
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
    ...(report ? { report } : {}),
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
          ...(page.report ? { report: page.report } : {}),
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
