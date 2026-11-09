import {
  CONTENT_SORT_FIELDS,
  CONTENT_STATUSES,
  ContentNotFoundError,
  ContentValidationError,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type Capabilities,
  type Content,
  type ContentService,
  type ContentSortField,
  type ContentStatusName,
  type ContentTypeRegistry,
  type CreateContentInput,
  type HookRegistry,
  type UpdateContentInput,
  type User,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { readLimited } from './media.js';

declare module '@nodepress/core' {
  interface FilterMap {
    /**
     * The JSON body of a successful content API response, just before it is sent. Return an
     * object to replace it; anything else is ignored. `route` is one of `content-types:list`,
     * `content:list`, `content:get`, `content:create`, `content:update` or `content:trash`.
     */
    'api:response': {
      value: unknown;
      context: { route: string; method: string; status: number; user: User };
    };
  }
}

export interface ContentApiOptions {
  content: ContentService;
  types: ContentTypeRegistry;
  capabilities: Capabilities;
  hooks: HookRegistry;
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SEARCH_LENGTH = 200;
/** Statuses that make an item visible beyond its author, or schedule it to be. */
const LIVE_STATUSES: readonly string[] = ['published', 'scheduled', 'private'];
const WRITABLE_KEYS = [
  'title',
  'slug',
  'status',
  'body',
  'excerpt',
  'authorId',
  'parentId',
  'publishedAt',
] as const;

/** The JSON shape of a content item. */
export function publicContent(item: Content): Record<string, unknown> {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title,
    slug: item.slug,
    body: item.body,
    excerpt: item.excerpt,
    authorId: item.authorId,
    parentId: item.parentId,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export const CONTENT_FIELD_NAMES = Object.keys(
  publicContent({
    id: 0,
    type: '',
    status: '',
    title: '',
    slug: '',
    body: [],
    excerpt: null,
    authorId: null,
    parentId: null,
    publishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }),
);

/** The capabilities that guard one content type. Pages have their own; every other type uses the post set. */
interface TypeCapabilities {
  edit: string;
  editOthers: string;
  editPublished: string;
  publish: string;
  delete: string;
  deleteOthers: string;
  deletePublished: string;
  readPrivate: string;
}

function capabilitiesFor(type: string): TypeCapabilities {
  return type === 'page'
    ? {
        edit: 'edit_pages',
        editOthers: 'edit_others_pages',
        editPublished: 'edit_pages',
        publish: 'publish_pages',
        delete: 'delete_pages',
        deleteOthers: 'delete_others_pages',
        deletePublished: 'delete_pages',
        readPrivate: 'read_private_posts',
      }
    : {
        edit: 'edit_posts',
        editOthers: 'edit_others_posts',
        editPublished: 'edit_published_posts',
        publish: 'publish_posts',
        delete: 'delete_posts',
        deleteOthers: 'delete_others_posts',
        deletePublished: 'delete_published_posts',
        readPrivate: 'read_private_posts',
      };
}

type Failure = { ok: false; response: Response };
type Parsed<T> = { ok: true; value: T } | Failure;

const badRequest = (c: Context, message: string): Failure => ({
  ok: false,
  response: c.json({ error: 'invalid_request', message }, 400),
});

function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseCount(c: Context, name: string, min: number, max: number): Parsed<number | undefined> {
  const raw = c.req.query(name);
  if (raw === undefined) return { ok: true, value: undefined };
  const value = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) {
    return badRequest(c, `${name} must be an integer from ${min} to ${max}`);
  }
  return { ok: true, value };
}

function pick(item: Record<string, unknown>, fields: string[] | undefined) {
  if (!fields) return item;
  return Object.fromEntries(fields.map((name) => [name, item[name]]));
}

function parseFields(c: Context): Parsed<string[] | undefined> {
  const raw = c.req.query('fields');
  if (raw === undefined) return { ok: true, value: undefined };
  const names = [...new Set(raw.split(',').map((s) => s.trim()))];
  const unknown = names.filter((name) => !CONTENT_FIELD_NAMES.includes(name));
  if (unknown.length > 0 || names.length === 0) {
    return badRequest(c, `fields must be a comma-separated list of: ${CONTENT_FIELD_NAMES.join(', ')}`);
  }
  return { ok: true, value: names };
}

async function readJsonObject(c: Context): Promise<Parsed<Record<string, unknown>>> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, response: c.json({ error: 'unsupported_media_type' }, 415) };
  }
  const raw = await readLimited(c.req.raw, MAX_JSON_BYTES);
  if (!raw) return { ok: false, response: c.json({ error: 'payload_too_large' }, 413) };
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, response: c.json({ error: 'invalid_json' }, 400) };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return badRequest(c, 'the body must be a JSON object');
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/**
 * Check the shape of a write body (types only; the content service validates the values) and
 * turn it into service input. Unknown keys are rejected, so nothing can be set by accident.
 */
function parseWrite(c: Context, body: Record<string, unknown>): Parsed<UpdateContentInput> {
  const unknown = Object.keys(body).filter(
    (key) => !(WRITABLE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) return badRequest(c, `unknown field: ${unknown.join(', ')}`);
  const out: UpdateContentInput = {};
  const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return badRequest(c, 'title must be a string');
    out.title = body.title;
  }
  if (body.slug !== undefined) {
    if (typeof body.slug !== 'string') return badRequest(c, 'slug must be a string');
    out.slug = body.slug;
  }
  if (body.status !== undefined) {
    if (body.status === 'trash') {
      return badRequest(c, 'to trash an item, send DELETE; to restore it, set another status');
    }
    if (!CONTENT_STATUSES.includes(body.status as ContentStatusName)) {
      return badRequest(c, `status must be one of ${CONTENT_STATUSES.join(', ')}`);
    }
    out.status = body.status as ContentStatusName;
  }
  if (body.body !== undefined) {
    if (!Array.isArray(body.body)) return badRequest(c, 'body must be an array of blocks');
    out.body = body.body;
  }
  if (body.excerpt !== undefined) {
    if (body.excerpt !== null && typeof body.excerpt !== 'string') {
      return badRequest(c, 'excerpt must be a string or null');
    }
    out.excerpt = body.excerpt as string | null;
  }
  for (const key of ['authorId', 'parentId'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && !isId(value)) return badRequest(c, `${key} must be a positive integer or null`);
    out[key] = value as number | null;
  }
  if (body.publishedAt !== undefined) {
    if (body.publishedAt === null) out.publishedAt = null;
    else {
      const date =
        typeof body.publishedAt === 'string' ? new Date(body.publishedAt) : new Date(Number.NaN);
      if (Number.isNaN(date.getTime())) return badRequest(c, 'publishedAt must be an ISO 8601 date');
      out.publishedAt = date;
    }
  }
  return { ok: true, value: out };
}

/** Routes under `/api/v1`: `/content-types`, `/content/:type[/:id]` and the public `/openapi.json`. */
export function createContentRoutes(auth: Auth, options: ContentApiOptions): Hono<AuthEnv> {
  const { content, types, capabilities, hooks } = options;
  const routes = new Hono<AuthEnv>();

  for (const path of ['/content', '/content/*', '/content-types']) {
    routes.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      await next();
    });
    routes.use(path, auth.originGuard);
    routes.use(path, auth.authenticate);
  }

  const userOf = (c: Context<AuthEnv>): User => c.get('principal')!.user;
  const can = (user: User, capability: string) => capabilities.can(user, capability);

  const respond = async (
    c: Context<AuthEnv>,
    route: string,
    status: 200 | 201,
    body: Record<string, unknown>,
  ) => {
    const filtered = await hooks.applyFilters('api:response', body, {
      route,
      method: c.req.method,
      status,
      user: userOf(c),
    });
    const isObject = typeof filtered === 'object' && filtered !== null && !Array.isArray(filtered);
    return c.json((isObject ? filtered : body) as Record<string, unknown>, status);
  };

  /** Can this user see the item at all? Items they may not see are reported as missing. */
  const canView = async (user: User, item: Content, caps: TypeCapabilities) => {
    if (!(await can(user, 'read'))) return false;
    if (item.status === 'published' || item.authorId === user.id) return true;
    return can(user, item.status === 'private' ? caps.readPrivate : caps.editOthers);
  };

  const canModify = async (
    user: User,
    item: Content,
    own: string,
    others: string,
    published: string,
  ) => {
    if (!(await can(user, own))) return false;
    if (item.authorId !== user.id && !(await can(user, others))) return false;
    return !LIVE_STATUSES.includes(item.status) || can(user, published);
  };

  /** Look up `:type`/`:id`, answering 404 for unknown types, missing items and items the user cannot see. */
  const find = async (c: Context<AuthEnv>) => {
    const type = c.req.param('type') ?? '';
    const id = parseId(c.req.param('id'));
    if (!types.has(type) || id === null) return null;
    const item = await content.get(id);
    const caps = capabilitiesFor(type);
    if (!item || item.type !== type || !(await canView(userOf(c), item, caps))) return null;
    return { type, item, caps };
  };

  const failure = (c: Context<AuthEnv>, error: unknown) => {
    if (error instanceof ContentValidationError) {
      return c.json({ error: 'invalid_request', message: error.message }, 400);
    }
    if (error instanceof ContentNotFoundError) return c.json({ error: 'not_found' }, 404);
    throw error;
  };

  const notFound = (c: Context<AuthEnv>) => c.json({ error: 'not_found' }, 404);

  routes.get('/content-types', async (c) =>
    respond(c, 'content-types:list', 200, {
      types: types.list().map((t) => ({
        name: t.name,
        label: t.label,
        labelPlural: t.labelPlural,
        hierarchical: t.hierarchical,
      })),
    }),
  );

  routes.get('/content/:type', async (c) => {
    const type = c.req.param('type');
    if (!types.has(type)) return c.json({ error: 'unknown_content_type' }, 404);
    const user = userOf(c);
    const caps = capabilitiesFor(type);
    if (!(await can(user, 'read'))) return c.json({ error: 'forbidden' }, 403);

    const limit = parseCount(c, 'limit', 1, MAX_LIST_LIMIT);
    if (!limit.ok) return limit.response;
    const offset = parseCount(c, 'offset', 0, 1_000_000_000);
    if (!offset.ok) return offset.response;
    const fields = parseFields(c);
    if (!fields.ok) return fields.response;

    const allItems = await can(user, caps.editOthers);
    const allPrivate = await can(user, caps.readPrivate);
    let statuses: ContentStatusName[] = allItems
      ? ['draft', 'scheduled', 'published', 'private']
      : ['published'];
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined) {
      statuses = [...new Set(rawStatus.split(',').map((s) => s.trim()))] as ContentStatusName[];
      if (statuses.some((s) => !CONTENT_STATUSES.includes(s))) {
        return badRequest(c, `status must be a comma-separated list of: ${CONTENT_STATUSES.join(', ')}`).response;
      }
    }

    const rawAuthor = c.req.query('author');
    let authorId: number | undefined;
    if (rawAuthor !== undefined) {
      authorId = rawAuthor === 'me' ? user.id : (parseId(rawAuthor) ?? undefined);
      if (authorId === undefined) return badRequest(c, 'author must be a user id or "me"').response;
    }
    // Other people's drafts and private items are not visible: asking for any status beyond
    // `published` narrows the list to the user's own items.
    const needsOwn = statuses.some(
      (s) => s !== 'published' && !(s === 'private' ? allPrivate && allItems : allItems),
    );
    if (needsOwn) {
      if (authorId !== undefined && authorId !== user.id) {
        return c.json({ error: 'forbidden' }, 403);
      }
      authorId = user.id;
    }

    let orderBy: ContentSortField = 'id';
    let direction: 'asc' | 'desc' = 'desc';
    const rawSort = c.req.query('sort');
    if (rawSort !== undefined) {
      const name = rawSort.startsWith('-') ? rawSort.slice(1) : rawSort;
      if (!(CONTENT_SORT_FIELDS as readonly string[]).includes(name)) {
        return badRequest(c, `sort must be one of: ${CONTENT_SORT_FIELDS.join(', ')} (prefix with "-" for descending)`).response;
      }
      orderBy = name as ContentSortField;
      direction = rawSort.startsWith('-') ? 'desc' : 'asc';
    }

    const search = c.req.query('q');
    if (search !== undefined && search.length > MAX_SEARCH_LENGTH) {
      return badRequest(c, `q must be at most ${MAX_SEARCH_LENGTH} characters`).response;
    }
    const slug = c.req.query('slug');

    const filter = {
      type,
      status: statuses,
      ...(authorId !== undefined ? { authorId } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(search !== undefined ? { search } : {}),
    };
    try {
      const [items, total] = await Promise.all([
        content.list({
          ...filter,
          orderBy,
          direction,
          limit: limit.value ?? DEFAULT_LIST_LIMIT,
          offset: offset.value ?? 0,
        }),
        content.count(filter),
      ]);
      return respond(c, 'content:list', 200, {
        items: items.map((item) => pick(publicContent(item), fields.value)),
        total,
        limit: limit.value ?? DEFAULT_LIST_LIMIT,
        offset: offset.value ?? 0,
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.get('/content/:type/:id', async (c) => {
    const fields = parseFields(c);
    if (!fields.ok) return fields.response;
    const found = await find(c);
    if (!found) return notFound(c);
    return respond(c, 'content:get', 200, { item: pick(publicContent(found.item), fields.value) });
  });

  routes.post('/content/:type', async (c) => {
    const type = c.req.param('type');
    if (!types.has(type)) return c.json({ error: 'unknown_content_type' }, 404);
    const user = userOf(c);
    const caps = capabilitiesFor(type);
    if (!(await can(user, caps.edit))) return c.json({ error: 'forbidden' }, 403);

    const raw = await readJsonObject(c);
    if (!raw.ok) return raw.response;
    const input = parseWrite(c, raw.value);
    if (!input.ok) return input.response;

    if (input.value.status !== undefined && input.value.status !== 'draft') {
      if (!(await can(user, caps.publish))) return c.json({ error: 'forbidden' }, 403);
    }
    if (
      input.value.authorId !== undefined &&
      input.value.authorId !== user.id &&
      !(await can(user, caps.editOthers))
    ) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const create: CreateContentInput = { ...input.value, type };
      const item = await content.create(create, { userId: user.id });
      return respond(c, 'content:create', 201, { item: publicContent(item) });
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.patch('/content/:type/:id', async (c) => {
    const found = await find(c);
    if (!found) return notFound(c);
    const user = userOf(c);
    const { item, caps } = found;
    if (!(await canModify(user, item, caps.edit, caps.editOthers, caps.editPublished))) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const raw = await readJsonObject(c);
    if (!raw.ok) return raw.response;
    const input = parseWrite(c, raw.value);
    if (!input.ok) return input.response;

    const status = input.value.status;
    if (
      status !== undefined &&
      status !== item.status &&
      status !== 'draft' &&
      !(await can(user, caps.publish))
    ) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const authorId = input.value.authorId;
    if (
      authorId !== undefined &&
      authorId !== item.authorId &&
      !(await can(user, caps.editOthers))
    ) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const updated = await content.update(item.id, input.value, { userId: user.id });
      return respond(c, 'content:update', 200, { item: publicContent(updated) });
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.delete('/content/:type/:id', async (c) => {
    const found = await find(c);
    if (!found) return notFound(c);
    const user = userOf(c);
    const { item, caps } = found;
    if (!(await canModify(user, item, caps.delete, caps.deleteOthers, caps.deletePublished))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // An item goes to the trash first; deleting it again (or `?force=true`) removes it for good.
    if (item.status === 'trash' || c.req.query('force') === 'true') {
      await content.delete(item.id);
      return c.body(null, 204);
    }
    try {
      const trashed = await content.trash(item.id, { userId: user.id });
      return respond(c, 'content:trash', 200, { item: publicContent(trashed) });
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.get('/openapi.json', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.json(createOpenApiDocument(types));
  });

  return routes;
}

/** OpenAPI 3.1 description of the content API, listing the content types registered right now. */
export function createOpenApiDocument(types: ContentTypeRegistry): Record<string, unknown> {
  const typeParam = {
    name: 'type',
    in: 'path',
    required: true,
    description: 'Content type.',
    schema: { type: 'string', enum: types.list().map((t) => t.name) },
  };
  const idParam = {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'integer', minimum: 1 },
  };
  const fieldsParam = {
    name: 'fields',
    in: 'query',
    description: 'Comma-separated list of fields to return.',
    schema: { type: 'string', example: 'id,title,slug' },
  };
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const error = (description: string) => ({
    description,
    content: { 'application/json': { schema: ref('Error') } },
  });
  const item = (description: string) => ({
    description,
    content: {
      'application/json': {
        schema: { type: 'object', required: ['item'], properties: { item: ref('Content') } },
      },
    },
  });
  const jsonBody = (schema: string) => ({
    required: true,
    content: { 'application/json': { schema: ref(schema) } },
  });
  const unauthorized = error('Missing or invalid credentials.');
  const forbidden = error('The user lacks the required capability.');
  const missing = error('No such content type or item, or the item is not visible to the user.');
  const invalid = error('The request is invalid.');
  const security = [{ bearerAuth: [] }];

  return {
    openapi: '3.1.0',
    info: {
      title: 'NodePress content API',
      version: '1.0.0',
      description:
        'Authenticate with `Authorization: Bearer <api token>`. Browser sessions also work and ' +
        'need an `X-CSRF-Token` header on writes. Non-published items are visible only to their ' +
        'author and to users who may edit others\' items.',
    },
    paths: {
      '/api/v1/content-types': {
        get: {
          operationId: 'listContentTypes',
          summary: 'List the registered content types',
          security,
          responses: {
            '200': {
              description: 'The content types.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['types'],
                    properties: { types: { type: 'array', items: ref('ContentType') } },
                  },
                },
              },
            },
            '401': unauthorized,
          },
        },
      },
      '/api/v1/content/{type}': {
        get: {
          operationId: 'listContent',
          summary: 'List content of a type',
          security,
          parameters: [
            typeParam,
            {
              name: 'status',
              in: 'query',
              description:
                'Comma-separated statuses. Defaults to every status except trash for users who ' +
                'may edit others\' items, and to `published` for everyone else.',
              schema: { type: 'string', example: 'draft,published' },
            },
            {
              name: 'author',
              in: 'query',
              description: 'A user id, or `me`.',
              schema: { type: 'string' },
            },
            { name: 'slug', in: 'query', schema: { type: 'string' } },
            {
              name: 'q',
              in: 'query',
              description: 'Text the title must contain (case-insensitive).',
              schema: { type: 'string', maxLength: MAX_SEARCH_LENGTH },
            },
            {
              name: 'sort',
              in: 'query',
              description: 'A field, with a leading `-` for descending. Default `-id`.',
              schema: { type: 'string', enum: CONTENT_SORT_FIELDS.flatMap((f) => [f, `-${f}`]) },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT },
            },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
            fieldsParam,
          ],
          responses: {
            '200': {
              description: 'A page of items.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items', 'total', 'limit', 'offset'],
                    properties: {
                      items: { type: 'array', items: ref('Content') },
                      total: { type: 'integer', description: 'Matches across all pages.' },
                      limit: { type: 'integer' },
                      offset: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': invalid,
            '401': unauthorized,
            '403': forbidden,
            '404': missing,
          },
        },
        post: {
          operationId: 'createContent',
          summary: 'Create an item',
          description:
            'Needs the type\'s edit capability, plus its publish capability for any status other than `draft`.',
          security,
          parameters: [typeParam],
          requestBody: jsonBody('ContentInput'),
          responses: {
            '201': item('The created item.'),
            '400': invalid,
            '401': unauthorized,
            '403': forbidden,
            '404': missing,
            '413': error('The body is too large.'),
            '415': error('The body must be application/json.'),
          },
        },
      },
      '/api/v1/content/{type}/{id}': {
        get: {
          operationId: 'getContent',
          summary: 'Get an item',
          security,
          parameters: [typeParam, idParam, fieldsParam],
          responses: {
            '200': item('The item.'),
            '400': invalid,
            '401': unauthorized,
            '404': missing,
          },
        },
        patch: {
          operationId: 'updateContent',
          summary: 'Update an item',
          description:
            'Send only the fields to change. Setting a status other than `draft` needs the publish capability. A slug change keeps the old URL working through a redirect.',
          security,
          parameters: [typeParam, idParam],
          requestBody: jsonBody('ContentInput'),
          responses: {
            '200': item('The updated item.'),
            '400': invalid,
            '401': unauthorized,
            '403': forbidden,
            '404': missing,
            '413': error('The body is too large.'),
            '415': error('The body must be application/json.'),
          },
        },
        delete: {
          operationId: 'deleteContent',
          summary: 'Trash or delete an item',
          description:
            'Moves the item to the trash. Deleting a trashed item, or passing `force=true`, removes it permanently.',
          security,
          parameters: [
            typeParam,
            idParam,
            { name: 'force', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: {
            '200': item('The trashed item.'),
            '204': { description: 'The item was permanently deleted.' },
            '401': unauthorized,
            '403': forbidden,
            '404': missing,
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
        ContentType: {
          type: 'object',
          required: ['name', 'label', 'labelPlural', 'hierarchical'],
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            labelPlural: { type: 'string' },
            hierarchical: { type: 'boolean' },
          },
        },
        Block: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string' },
            attrs: { type: 'object', additionalProperties: true },
            text: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/components/schemas/Block' } },
          },
        },
        Content: {
          type: 'object',
          required: [...CONTENT_FIELD_NAMES],
          properties: {
            id: { type: 'integer' },
            type: { type: 'string' },
            status: { type: 'string', enum: [...CONTENT_STATUSES] },
            title: { type: 'string' },
            slug: { type: 'string' },
            body: { type: 'array', items: ref('Block') },
            excerpt: { type: ['string', 'null'] },
            authorId: { type: ['integer', 'null'] },
            parentId: { type: ['integer', 'null'] },
            publishedAt: { type: ['string', 'null'], format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ContentInput: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            slug: { type: 'string', description: 'Generated from the title when omitted.' },
            status: { type: 'string', enum: CONTENT_STATUSES.filter((s) => s !== 'trash') },
            body: { type: 'array', items: ref('Block') },
            excerpt: { type: ['string', 'null'] },
            authorId: {
              type: ['integer', 'null'],
              description: 'Defaults to the caller. Assigning someone else needs the edit-others capability.',
            },
            parentId: { type: ['integer', 'null'] },
            publishedAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
      },
    },
  };
}
