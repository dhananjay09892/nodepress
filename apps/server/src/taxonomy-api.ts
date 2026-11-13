import {
  TaxonomyError,
  TermNotFoundError,
  TermValidationError,
  UnknownTaxonomyError,
  type Capabilities,
  type TaxonomyService,
  type Term,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface TaxonomyRoutesOptions {
  taxonomies: TaxonomyService;
  capabilities: Capabilities;
}

const MAX_BODY_BYTES = 8 * 1024;

function publicTerm(term: Term) {
  return { id: term.id, name: term.name, slug: term.slug, parentId: term.parentId };
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return null;
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Routes for `/api/v1/taxonomies`: the terms the admin shows in the post sidebar (a checklist of
 * categories, tag suggestions) and tags created on the fly. Everything needs `manage_categories`,
 * the same capability the content API asks for when terms are assigned, so a person who cannot
 * assign terms gets a 403 and the admin hides the panels.
 */
export function createTaxonomyRoutes(auth: Auth, options: TaxonomyRoutesOptions): Hono<AuthEnv> {
  const { taxonomies, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'manage_categories'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  routes.get('/:taxonomy/terms', async (c) => {
    const name = c.req.param('taxonomy');
    const taxonomy = taxonomies.getTaxonomy(name);
    if (!taxonomy) return c.json({ error: 'not_found' }, 404);
    const terms = await taxonomies.listTerms(name);
    return c.json({
      taxonomy: {
        name: taxonomy.name,
        label: taxonomy.label,
        hierarchical: taxonomy.hierarchical,
        contentTypes: taxonomy.contentTypes,
      },
      terms: terms.map(publicTerm),
    });
  });

  /** Finds the term with this name or creates it, so typing an existing tag never duplicates it. */
  routes.post('/:taxonomy/terms', async (c) => {
    const name = c.req.param('taxonomy');
    if (!taxonomies.hasTaxonomy(name)) return c.json({ error: 'not_found' }, 404);
    const body = await readBody(c);
    if (!body || typeof body.name !== 'string') {
      return c.json({ error: 'invalid_request', message: 'name must be a string' }, 400);
    }
    const parentId = body.parentId;
    if (parentId !== undefined && parentId !== null && !Number.isSafeInteger(parentId)) {
      return c.json({ error: 'invalid_request', message: 'parentId must be an id' }, 400);
    }
    try {
      const term = await taxonomies.findOrCreateTerm(name, body.name, parentId as number | null);
      return c.json({ term: publicTerm(term) }, 201);
    } catch (error) {
      if (error instanceof UnknownTaxonomyError) return c.json({ error: 'not_found' }, 404);
      if (
        error instanceof TermValidationError ||
        error instanceof TermNotFoundError ||
        error instanceof TaxonomyError
      ) {
        return c.json({ error: 'invalid_request', message: error.message }, 400);
      }
      throw error;
    }
  });

  return routes;
}
