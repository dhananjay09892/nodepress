/**
 * HTTP routes added by plugins. A plugin describes a route with `context.routes.add()`; the server
 * mounts it under `/api/v1/plugins/<plugin name>/` and runs the checks (login, capability, CSRF)
 * before the handler. The types here do not depend on a web framework.
 */

export const PLUGIN_ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type PluginRouteMethod = (typeof PLUGIN_ROUTE_METHODS)[number];

/** What a plugin route handler receives. */
export interface PluginRouteRequest {
  method: PluginRouteMethod;
  /** The path after `/api/v1/plugins/<name>`, for example `/items/7`. */
  path: string;
  /** Values of `:name` segments in the route path. */
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  /** Request headers, names in lower case. */
  headers: Readonly<Record<string, string>>;
  /** The signed-in user, or `null` on a `public` route without credentials. */
  user: { id: number; email: string; role: string } | null;
  /** The body parsed as JSON (up to 1 MB). Rejects with a `PluginRouteBodyError` when it is not JSON. */
  json(): Promise<unknown>;
}

/** What a handler returns. `json` wins over `text`; with neither the body is empty. */
export interface PluginRouteResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type PluginRouteHandler = (
  request: PluginRouteRequest,
) => PluginRouteResponse | Promise<PluginRouteResponse>;

export interface PluginRouteDefinition {
  method: PluginRouteMethod;
  /** Starts with `/`; segments written `:id` are captured in `params`. */
  path: string;
  /**
   * Who may call it: a capability name (`manage_options`, `edit_posts`, …; the caller must be
   * signed in and hold it, and session writes need the CSRF token) or `'public'` (anyone; use it
   * only for things that are safe for the whole internet, and validate every input).
   */
  capability: string;
  handler: PluginRouteHandler;
}

export class PluginRouteBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRouteBodyError';
  }
}

/** The part of a route definition path that is checked when it is added. */
const SEGMENT = /^(?::[a-z][a-zA-Z0-9_]*|[a-zA-Z0-9._~-]+)$/;
const MAX_PATH_LENGTH = 200;

interface CompiledRoute {
  source: string;
  definition: PluginRouteDefinition;
  keys: string[];
  pattern: RegExp;
}

export interface MatchedPluginRoute {
  source: string;
  definition: PluginRouteDefinition;
  params: Record<string, string>;
}

/** Throws a `TypeError` when the definition is not usable. */
export function checkRouteDefinition(definition: PluginRouteDefinition): void {
  if (!(PLUGIN_ROUTE_METHODS as readonly string[]).includes(definition?.method)) {
    throw new TypeError(`Route method must be one of ${PLUGIN_ROUTE_METHODS.join(', ')}`);
  }
  const { path } = definition;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LENGTH) {
    throw new TypeError('Route path must be a string that starts with "/"');
  }
  const segments = path === '/' ? [] : path.slice(1).split('/');
  const keys = new Set<string>();
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new TypeError(`Route path "${path}" has an invalid segment "${segment}"`);
    }
    if (segment.startsWith(':')) {
      if (keys.has(segment)) throw new TypeError(`Route path "${path}" repeats "${segment}"`);
      keys.add(segment);
    }
  }
  if (typeof definition.capability !== 'string' || definition.capability === '') {
    throw new TypeError('Route needs a capability name, or "public" for anyone');
  }
  if (typeof definition.handler !== 'function') {
    throw new TypeError('Route needs a handler function');
  }
}

/** The routes of all plugins, keyed by plugin name; removed per plugin on deactivation. */
export class PluginRouteRegistry {
  readonly #routes: CompiledRoute[] = [];

  /** Add a route for `source` (a plugin name). The same method and path twice is an error. */
  add(source: string, definition: PluginRouteDefinition): void {
    checkRouteDefinition(definition);
    const keys: string[] = [];
    const parts = (definition.path === '/' ? [] : definition.path.slice(1).split('/')).map((s) => {
      if (s.startsWith(':')) {
        keys.push(s.slice(1));
        return '([^/]+)';
      }
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    const pattern = new RegExp(parts.length === 0 ? '^/?$' : `^/${parts.join('/')}$`);
    const clash = this.#routes.find(
      (r) =>
        r.source === source &&
        r.definition.method === definition.method &&
        r.definition.path.replace(/:[^/]+/g, ':') === definition.path.replace(/:[^/]+/g, ':'),
    );
    if (clash) {
      throw new Error(`Plugin "${source}" already has a ${definition.method} route for ${definition.path}`);
    }
    this.#routes.push({ source, definition, keys, pattern });
  }

  /** Find the route of `source` for a request, or `undefined`. */
  match(source: string, method: string, path: string): MatchedPluginRoute | undefined {
    for (const route of this.#routes) {
      if (route.source !== source || route.definition.method !== method) continue;
      const found = route.pattern.exec(path);
      if (!found) continue;
      const params: Record<string, string> = {};
      let valid = true;
      route.keys.forEach((key, index) => {
        try {
          params[key] = decodeURIComponent(found[index + 1] ?? '');
        } catch {
          valid = false;
        }
      });
      if (valid) return { source, definition: route.definition, params };
    }
    return undefined;
  }

  /** Whether `source` has any route for this path, with any method (for a 405 answer). */
  allowedMethods(source: string, path: string): PluginRouteMethod[] {
    const methods = new Set<PluginRouteMethod>();
    for (const route of this.#routes) {
      if (route.source === source && route.pattern.test(path)) methods.add(route.definition.method);
    }
    return [...methods];
  }

  removeAllFromSource(source: string): void {
    for (let i = this.#routes.length - 1; i >= 0; i--) {
      if (this.#routes[i]!.source === source) this.#routes.splice(i, 1);
    }
  }

  /** The routes of a plugin, for the permission review in the admin. */
  list(source?: string): Array<{ source: string; method: PluginRouteMethod; path: string; capability: string }> {
    return this.#routes
      .filter((r) => source === undefined || r.source === source)
      .map((r) => ({
        source: r.source,
        method: r.definition.method,
        path: r.definition.path,
        capability: r.definition.capability,
      }));
  }
}

/** What `context.routes` gives a plugin. */
export interface ScopedPluginRoutes {
  /** Add a route under `/api/v1/plugins/<your plugin name>/`. Removed when the plugin is deactivated. */
  add(definition: PluginRouteDefinition): void;
}
