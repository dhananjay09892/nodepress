import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Content } from './content.js';
import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';

declare module './hooks.js' {
  interface FilterMap {
    /**
     * The template names to try for a page, most specific first (for example
     * `['single-product', 'single', 'index']`). Plugins can add, remove or reorder names.
     * Names the active theme does not have are skipped.
     */
    'template:resolve': { value: string[]; context: { target: TemplateTarget } };
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

/** Theme and template names: lowercase words joined by single dashes. */
export const THEME_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SUB_DIR_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
/** A `theme.json` larger than this is rejected. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

/** A validated `theme.json`. */
export interface ThemeManifest {
  /** Unique id; must equal the theme's folder name. */
  name: string;
  version: string;
  /** Human-readable name (defaults to `name`). */
  title: string;
  description?: string;
  /** Features the theme supports, e.g. `dark-mode` or `menus`. */
  supports: string[];
  /** Settings schema for the customizer (edited in the admin); kept as given. */
  settings: Record<string, unknown>;
  /** Folder of templates, relative to the theme (default `templates`). */
  templates: string;
  /** Folder of static assets, relative to the theme (default `assets`). */
  assets: string;
}

export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSubDir(raw: Record<string, unknown>, key: 'templates' | 'assets'): string {
  const value = raw[key] ?? key;
  if (typeof value !== 'string' || !SUB_DIR_PATTERN.test(value)) {
    throw new ThemeError(`"${key}" must be a relative folder such as "${key}"`);
  }
  return value;
}

/** Validate the parsed contents of a `theme.json`. Throws `ThemeError` with a readable message. */
export function parseThemeManifest(raw: unknown): ThemeManifest {
  if (!isRecord(raw)) throw new ThemeError('theme.json must be an object');
  const { name, version } = raw;
  if (typeof name !== 'string' || !THEME_NAME_PATTERN.test(name) || name.length > 64) {
    throw new ThemeError('"name" must be lowercase letters, digits and dashes (max 64)');
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new ThemeError('"version" must look like 1.2.3');
  }
  const title = raw.title ?? name;
  if (typeof title !== 'string' || title.trim() === '' || title.length > 100) {
    throw new ThemeError('"title" must be a non-empty string (max 100)');
  }
  if (
    raw.description !== undefined &&
    (typeof raw.description !== 'string' || raw.description.length > 500)
  ) {
    throw new ThemeError('"description" must be a string (max 500)');
  }
  const supports = raw.supports ?? [];
  if (
    !Array.isArray(supports) ||
    supports.length > 50 ||
    !supports.every((s) => typeof s === 'string' && THEME_NAME_PATTERN.test(s))
  ) {
    throw new ThemeError('"supports" must be a list of feature names such as "dark-mode"');
  }
  const settings = raw.settings ?? {};
  if (!isRecord(settings)) throw new ThemeError('"settings" must be an object');
  return {
    name,
    version,
    title: title.trim(),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    supports: [...new Set(supports as string[])],
    settings,
    templates: readSubDir(raw, 'templates'),
    assets: readSubDir(raw, 'assets'),
  };
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

/** An installed theme. */
export interface Theme {
  manifest: ThemeManifest;
  /** Absolute folder of the theme. */
  dir: string;
  /** Absolute folder of its static assets (may not exist). */
  assetsDir: string;
  /** Template name (`single-product`) → absolute file path. */
  templates: Record<string, string>;
}

export interface ThemeLoadError {
  /** Folder name of the theme that could not be loaded. */
  dir: string;
  message: string;
}

export interface ThemeDiscovery {
  themes: Theme[];
  errors: ThemeLoadError[];
}

/** File types a template can have. A compiled `.js` is preferred over `.mjs`, then `.tsx`. */
export const TEMPLATE_EXTENSIONS = ['.js', '.mjs', '.tsx'] as const;
const TEMPLATE_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(js|mjs|tsx)$/;

async function listTemplates(dir: string): Promise<Record<string, string>> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return {};
  }
  const found: Record<string, string> = {};
  const rank = (file: string) => TEMPLATE_EXTENSIONS.findIndex((ext) => file.endsWith(ext));
  for (const file of files.sort()) {
    const match = TEMPLATE_FILE.exec(file);
    if (!match) continue;
    const name = match[1]!;
    const current = found[name];
    if (current === undefined || rank(file) < rank(current)) found[name] = file;
  }
  return Object.fromEntries(Object.entries(found).map(([name, file]) => [name, join(dir, file)]));
}

/**
 * Find themes: every sub-folder of `root` with a `theme.json`. A broken theme (bad manifest,
 * folder name different from `name`) is reported in `errors` and skipped; it never throws.
 */
export async function discoverThemes(root: string): Promise<ThemeDiscovery> {
  const result: ThemeDiscovery = { themes: [], errors: [] };
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result; // no themes folder: nothing to load
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(root, entry.name);
    let text: string;
    try {
      text = await readFile(join(dir, 'theme.json'), 'utf8');
    } catch {
      continue; // not a theme
    }
    try {
      if (text.length > MAX_MANIFEST_BYTES) throw new ThemeError('theme.json is too large');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ThemeError('theme.json is not valid JSON');
      }
      const manifest = parseThemeManifest(json);
      if (manifest.name !== entry.name) {
        throw new ThemeError(`"name" is "${manifest.name}" but the folder is "${entry.name}"`);
      }
      result.themes.push({
        manifest,
        dir,
        assetsDir: join(dir, manifest.assets),
        templates: await listTemplates(join(dir, manifest.templates)),
      });
    } catch (error) {
      result.errors.push({
        dir: entry.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Template hierarchy
// ---------------------------------------------------------------------------------------------

/** What is being shown, used to pick a template. */
export type TemplateTarget =
  | { kind: 'single'; type: string; slug: string }
  | { kind: 'archive'; type: string }
  | { kind: 'front' }
  | { kind: 'not_found' };

/**
 * Template names to try, most specific first, ending in `index`:
 *
 * - a `page`: `page-{slug}` → `page` → `single` → `index`
 * - other content: `single-{type}` → `single` → `index` (`single-product` → `single` → `index`)
 * - archive of a type: `archive-{type}` → `archive` → `index`
 * - front page: `front` → `index`; not found: `404` → `index`
 *
 * Names that are not valid template names (odd characters in a type or slug) are left out.
 */
export function templateHierarchy(target: TemplateTarget): string[] {
  let names: string[];
  switch (target.kind) {
    case 'single':
      names =
        target.type === 'page'
          ? [`page-${target.slug}`, 'page', 'single', 'index']
          : [`single-${target.type}`, 'single', 'index'];
      break;
    case 'archive':
      names = [`archive-${target.type}`, 'archive', 'index'];
      break;
    case 'front':
      names = ['front', 'index'];
      break;
    case 'not_found':
      names = ['404', 'index'];
      break;
  }
  return names.filter((name) => THEME_NAME_PATTERN.test(name));
}

// ---------------------------------------------------------------------------------------------
// Rendering contract
// ---------------------------------------------------------------------------------------------

/** What every template receives as props. */
export interface TemplateProps {
  siteName: string;
  /** Request path. */
  path: string;
  status: 200 | 404;
  /** The content being shown (not set on the 404 page). */
  content?: Content;
  /** Body of `content` as HTML, when the server could render it. */
  html?: string;
  /** The site tagline (empty when not set). */
  tagline?: string;
  /** Latest published posts with their URLs; set on the front page. */
  posts?: Array<{ content: Content; url: string }>;
  /** The theme's settings: defaults from `theme.json` `settings`, with any overrides applied. */
  settings?: Record<string, unknown>;
  theme: {
    name: string;
    version: string;
    /** URL prefix of the theme's assets, e.g. `/themes/starter/assets`. */
    assetsUrl: string;
  };
}

/** A template: a component (function) that returns markup. Servers render it to HTML. */
export type TemplateComponent = (props: TemplateProps) => unknown;

/** Turns a template file path into its module. Defaults to a dynamic `import()`. */
export type TemplateImporter = (file: string) => Promise<unknown>;

const defaultImporter: TemplateImporter = (file) => import(pathToFileURL(file).href);

export interface ThemeServiceOptions {
  hooks: HookRegistry;
  logger?: Logger;
  /** Replace `import()` (for tests). */
  importer?: TemplateImporter;
}

export interface ResolvedTemplate {
  name: string;
  component: TemplateComponent;
}

/**
 * Holds the installed themes and the active one, and finds templates for pages.
 *
 * A theme that is missing or whose template cannot be loaded never breaks the site:
 * `resolve()` returns `undefined` and the caller shows its built-in page.
 */
export class ThemeService {
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #importer: TemplateImporter;
  readonly #themes = new Map<string, Theme>();
  readonly #loaded = new Map<string, Promise<TemplateComponent | undefined>>();
  #active: string | undefined;

  constructor(options: ThemeServiceOptions) {
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    this.#importer = options.importer ?? defaultImporter;
  }

  /** Make themes known (replaces any theme with the same name). */
  register(themes: Theme[]): void {
    for (const theme of themes) {
      this.#themes.set(theme.manifest.name, theme);
      for (const key of this.#loaded.keys()) {
        if (key.startsWith(`${theme.manifest.name}\0`)) this.#loaded.delete(key);
      }
    }
  }

  list(): Theme[] {
    return [...this.#themes.values()];
  }

  get(name: string): Theme | undefined {
    return this.#themes.get(name);
  }

  /** Choose the active theme. Returns false (and keeps the old one) if it is not installed. */
  activate(name: string): boolean {
    if (!this.#themes.has(name)) return false;
    this.#active = name;
    return true;
  }

  get active(): Theme | undefined {
    return this.#active === undefined ? undefined : this.#themes.get(this.#active);
  }

  /** Candidate names for a page after the `template:resolve` filter. */
  async candidates(target: TemplateTarget): Promise<string[]> {
    const builtIn = templateHierarchy(target);
    const filtered = await this.#hooks.applyFilters('template:resolve', builtIn, { target });
    if (!Array.isArray(filtered)) return builtIn;
    return filtered.filter((n): n is string => typeof n === 'string' && THEME_NAME_PATTERN.test(n));
  }

  /**
   * The first template of the active theme that exists and loads, for this page. Templates that
   * fail to load are logged and skipped, so a less specific one can still be used.
   */
  async resolve(target: TemplateTarget): Promise<ResolvedTemplate | undefined> {
    const theme = this.active;
    if (!theme) return undefined;
    for (const name of await this.candidates(target)) {
      if (!Object.hasOwn(theme.templates, name)) continue;
      const component = await this.#load(theme, name);
      if (component) return { name, component };
    }
    return undefined;
  }

  #load(theme: Theme, name: string): Promise<TemplateComponent | undefined> {
    const key = `${theme.manifest.name}\0${name}`;
    let pending = this.#loaded.get(key);
    if (!pending) {
      pending = this.#importer(theme.templates[name]!).then(
        (module) => {
          const component = isRecord(module) ? module.default : undefined;
          if (typeof component === 'function') return component as TemplateComponent;
          this.#logger.warn(
            `Theme "${theme.manifest.name}": template "${name}" has no default export function`,
          );
          return undefined;
        },
        (error: unknown) => {
          this.#logger.warn(
            `Theme "${theme.manifest.name}": template "${name}" could not be loaded: ${String(error)}`,
          );
          return undefined;
        },
      );
      this.#loaded.set(key, pending);
    }
    return pending;
  }
}

export function createThemeService(options: ThemeServiceOptions): ThemeService {
  return new ThemeService(options);
}
