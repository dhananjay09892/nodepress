import {
  CONTENT_SORT_FIELDS,
  CONTENT_STATUSES,
  ContentNotFoundError,
  ContentValidationError,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_TERMS_PER_ASSIGNMENT,
  TermValidationError,
  type Capabilities,
  type Content,
  type ContentService,
  type ContentSortField,
  type ContentStatusName,
  type ContentTypeRegistry,
  type CreateContentInput,
  type FieldDefinition,
  type FieldIssue,
  type HookRegistry,
  type OptionsService,
  type TaxonomyService,
  type Term,
  type UpdateContentInput,
  type User,
} from '@nodepress/core';
import type { ContentMetaTableStore } from '@nodepress/db';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Auth, AuthEnv } from './auth.js';
import { readLimited } from './media.js';

declare module '@nodepress/core' {
  interface FilterMap {
    /**
     * The JSON body of a successful content API response, just before it is sent. Return an
     * object to replace it; anything else is ignored. `route` is one of `content-types:list`,
     * `content:list`, `content:get`, `content:create`, `content:update`, `content:trash` or
     * `content:revisions`.
     */
    'api:response': {
      value: unknown;
      /** `user` is `null` for an anonymous read of published content (see `api_public_read`). */
      context: { route: string; method: string; status: number; user: User | null };
    };
  }
  interface OptionMap {
    /**
     * When `true`, anyone may `GET` published items from `/api/v1/content/:type[/:id]` without
     * credentials, for headless sites. Off by default. Requests that do send credentials are
     * still authenticated, and everything else on the API still needs them.
     */
    api_public_read: boolean;
  }
}

export interface ContentApiOptions {
  content: ContentService;
  types: ContentTypeRegistry;
  capabilities: Capabilities;
  hooks: HookRegistry;
  /** Stores custom field values. Without it the routes neither accept nor return `meta`. */
  meta?: ContentMetaTableStore;
  /** Assigns terms. Without it the routes neither accept nor return `terms`. */
  taxonomies?: TaxonomyService;
  /** Where the `api_public_read` setting lives. Without it anonymous reads are always off. */
  options?: OptionsService;
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

function parseCount(
  c: Context,
  name: string,
  min: number,
  max: number,
): Parsed<number | undefined> {
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

function parseFields(c: Context, allowed: readonly string[]): Parsed<string[] | undefined> {
  const raw = c.req.query('fields');
  if (raw === undefined) return { ok: true, value: undefined };
  const names = [...new Set(raw.split(',').map((s) => s.trim()))];
  const unknown = names.filter((name) => !allowed.includes(name));
  if (unknown.length > 0 || names.length === 0) {
    return badRequest(c, `fields must be a comma-separated list of: ${allowed.join(', ')}`);
  }
  return { ok: true, value: names };
}

/** A 400 that lists every invalid custom field value, not just the first. */
function invalidValues(c: Context, issues: FieldIssue[]): Failure {
  const message = issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');
  return {
    ok: false,
    response: c.json({ error: 'invalid_request', message: `meta: ${message}`, issues }, 400),
  };
}

/** Custom field values and term assignments sent along with the core fields of a write. */
interface ExtraWrite {
  meta?: Record<string, unknown>;
  /** Taxonomy name to the ids of the terms the item should have in it. */
  terms?: Record<string, number[]>;
}

/**
 * Take `meta` and `terms` out of a write body when those features are enabled, checking only
 * their shape. What is left goes through `parseWrite`, which rejects anything it does not know.
 */
function splitWrite(
  c: Context,
  body: Record<string, unknown>,
  enabled: { meta: boolean; terms: boolean },
): Parsed<{ core: Record<string, unknown>; extra: ExtraWrite }> {
  const { meta, terms, ...core } = body;
  const extra: ExtraWrite = {};
  if (!enabled.meta) Object.assign(core, meta === undefined ? {} : { meta });
  else if (meta !== undefined) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      return badRequest(c, 'meta must be an object of custom field values');
    }
    extra.meta = meta as Record<string, unknown>;
  }
  if (!enabled.terms) Object.assign(core, terms === undefined ? {} : { terms });
  else if (terms !== undefined) {
    if (typeof terms !== 'object' || terms === null || Array.isArray(terms)) {
      return badRequest(c, 'terms must be an object of taxonomy name to a list of term ids');
    }
    const checked: Record<string, number[]> = {};
    for (const [taxonomy, ids] of Object.entries(terms)) {
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_TERMS_PER_ASSIGNMENT ||
        !ids.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      ) {
        return badRequest(
          c,
          `terms.${taxonomy} must be a list of at most ${MAX_TERMS_PER_ASSIGNMENT} term ids`,
        );
      }
      checked[taxonomy] = [...new Set(ids as number[])];
    }
    extra.terms = checked;
  }
  return { ok: true, value: { core, extra } };
}

function publicTerm(term: Term) {
  return { id: term.id, name: term.name, slug: term.slug, parentId: term.parentId };
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
  const isId = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
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
    if (value !== null && !isId(value))
      return badRequest(c, `${key} must be a positive integer or null`);
    out[key] = value as number | null;
  }
  if (body.publishedAt !== undefined) {
    if (body.publishedAt === null) out.publishedAt = null;
    else {
      const date =
        typeof body.publishedAt === 'string' ? new Date(body.publishedAt) : new Date(Number.NaN);
      if (Number.isNaN(date.getTime()))
        return badRequest(c, 'publishedAt must be an ISO 8601 date');
      out.publishedAt = date;
    }
  }
  return { ok: true, value: out };
}

/** Routes under `/api/v1`: `/content-types`, `/content/:type[/:id]` and the public `/openapi.json`. */
export function createContentRoutes(auth: Auth, options: ContentApiOptions): Hono<AuthEnv> {
  const { content, types, capabilities, hooks, meta, taxonomies } = options;
  const routes = new Hono<AuthEnv>();

  const publicReadsEnabled = async () =>
    options.options !== undefined && (await options.options.get('api_public_read', false)) === true;

  for (const path of ['/content', '/content/*', '/content-types']) {
    routes.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      await next();
    });
    routes.use(path, auth.originGuard);
  }
  routes.use('/content-types', auth.authenticate);
  routes.use('/content', auth.authenticate);
  routes.use('/content/*', async (c, next) => {
    // Only a plain GET with no credentials at all can be anonymous: anything that presents a
    // token or a session cookie is checked, and a bad one is rejected, never downgraded.
    const anonymous =
      c.req.method === 'GET' &&
      c.req.header('authorization') === undefined &&
      getCookie(c, auth.cookieName) === undefined &&
      (await publicReadsEnabled());
    if (anonymous) {
      c.set('principal', null);
      await next();
      return;
    }
    return auth.authenticate(c, next);
  });

  /** The signed-in user; only for routes that are never anonymous. */
  const userOf = (c: Context<AuthEnv>): User => c.get('principal')!.user;
  /** The signed-in user, or `null` for an anonymous read. */
  const viewerOf = (c: Context<AuthEnv>): User | null => c.get('principal')?.user ?? null;
  const can = (user: User, capability: string) => capabilities.can(user, capability);

  const selectableFields = [
    ...CONTENT_FIELD_NAMES,
    ...(meta ? ['meta'] : []),
    ...(taxonomies ? ['terms'] : []),
  ];

  /**
   * The JSON of items, with their custom fields (`meta`) and terms when wanted. Only values of
   * fields the content type defines are returned, so keys other code keeps in `content_meta`
   * never leak through the API.
   */
  const present = async (
    items: Content[],
    want: { meta: boolean; terms: boolean },
  ): Promise<Record<string, unknown>[]> => {
    const out = items.map((item) => publicContent(item));
    if (want.meta && meta) {
      const stored = await meta.getMetaMany(items.map((item) => item.id));
      items.forEach((item, i) => {
        const defined = new Set((types.get(item.type)?.fields ?? []).map((f) => f.name));
        const values = stored.get(item.id) ?? {};
        out[i]!.meta = Object.fromEntries(Object.entries(values).filter(([k]) => defined.has(k)));
      });
    }
    if (want.terms && taxonomies) {
      await Promise.all(
        items.map(async (item, i) => {
          const assigned = await taxonomies.getContentTerms(item.id);
          const grouped: Record<string, ReturnType<typeof publicTerm>[]> = {};
          for (const taxonomy of taxonomies.listTaxonomies()) {
            if (!taxonomy.contentTypes || taxonomy.contentTypes.includes(item.type)) {
              grouped[taxonomy.name] = [];
            }
          }
          for (const term of assigned) (grouped[term.taxonomy] ??= []).push(publicTerm(term));
          out[i]!.terms = grouped;
        }),
      );
    }
    return out;
  };

  /**
   * Check the `meta` and `terms` of a write against the content type registry and taxonomies,
   * before anything is saved. Updates only validate the fields that are present, and `null`
   * clears a field that is not required.
   */
  const checkExtra = async (
    c: Context<AuthEnv>,
    type: string,
    extra: ExtraWrite,
    isNew: boolean,
  ): Promise<Parsed<{ set: Record<string, unknown>; clear: string[] }>> => {
    const set: Record<string, unknown> = {};
    const clear: string[] = [];
    if (meta && (extra.meta !== undefined || isNew)) {
      const result = types.validate(type, extra.meta ?? {}, { partial: !isNew });
      if (!result.ok) return invalidValues(c, result.issues);
      for (const [key, value] of Object.entries(result.value)) {
        if (value === null || value === undefined) clear.push(key);
        else set[key] = value;
      }
    }
    if (taxonomies && extra.terms !== undefined) {
      for (const [name, ids] of Object.entries(extra.terms)) {
        const taxonomy = taxonomies.getTaxonomy(name);
        if (!taxonomy) return badRequest(c, `terms: unknown taxonomy "${name}"`);
        if (taxonomy.contentTypes && !taxonomy.contentTypes.includes(type)) {
          return badRequest(c, `terms: taxonomy "${name}" cannot be used with "${type}"`);
        }
        for (const id of ids) {
          const term = await taxonomies.getTerm(id);
          if (!term || term.taxonomy !== name) {
            return badRequest(c, `terms.${name}: term ${id} does not exist`);
          }
        }
      }
    }
    return { ok: true, value: { set, clear } };
  };

  const applyExtra = async (
    id: number,
    extra: ExtraWrite,
    checked: { set: Record<string, unknown>; clear: string[] },
  ) => {
    if (meta) {
      await meta.setMeta(id, checked.set);
      await meta.deleteMeta(id, checked.clear);
    }
    if (taxonomies && extra.terms) {
      for (const [name, ids] of Object.entries(extra.terms)) {
        await taxonomies.setContentTerms(id, name, ids);
      }
    }
  };

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
      user: viewerOf(c),
    });
    const isObject = typeof filtered === 'object' && filtered !== null && !Array.isArray(filtered);
    return c.json((isObject ? filtered : body) as Record<string, unknown>, status);
  };

  /** Can this user see the item at all? Items they may not see are reported as missing. */
  const canView = async (user: User | null, item: Content, caps: TypeCapabilities) => {
    // Anonymous visitors (when public reads are on) see published items and nothing else.
    if (!user) return item.status === 'published';
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
    if (!item || item.type !== type || !(await canView(viewerOf(c), item, caps))) return null;
    return { type, item, caps };
  };

  const failure = (c: Context<AuthEnv>, error: unknown) => {
    if (error instanceof ContentValidationError || error instanceof TermValidationError) {
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
    const user = viewerOf(c);
    const caps = capabilitiesFor(type);
    if (user && !(await can(user, 'read'))) return c.json({ error: 'forbidden' }, 403);

    const limit = parseCount(c, 'limit', 1, MAX_LIST_LIMIT);
    if (!limit.ok) return limit.response;
    const offset = parseCount(c, 'offset', 0, 1_000_000_000);
    if (!offset.ok) return offset.response;
    const fields = parseFields(c, selectableFields);
    if (!fields.ok) return fields.response;

    const allItems = user ? await can(user, caps.editOthers) : false;
    const allPrivate = user ? await can(user, caps.readPrivate) : false;
    let statuses: ContentStatusName[] = allItems
      ? ['draft', 'scheduled', 'published', 'private']
      : ['published'];
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined) {
      statuses = [...new Set(rawStatus.split(',').map((s) => s.trim()))] as ContentStatusName[];
      if (statuses.some((s) => !CONTENT_STATUSES.includes(s))) {
        return badRequest(
          c,
          `status must be a comma-separated list of: ${CONTENT_STATUSES.join(', ')}`,
        ).response;
      }
    }

    const rawAuthor = c.req.query('author');
    let authorId: number | undefined;
    if (rawAuthor !== undefined) {
      authorId = rawAuthor === 'me' ? user?.id : (parseId(rawAuthor) ?? undefined);
      if (authorId === undefined) return badRequest(c, 'author must be a user id or "me"').response;
    }
    // Other people's drafts and private items are not visible: asking for any status beyond
    // `published` narrows the list to the user's own items.
    const needsOwn = statuses.some(
      (s) => s !== 'published' && !(s === 'private' ? allPrivate && allItems : allItems),
    );
    if (needsOwn) {
      if (!user) return c.json({ error: 'forbidden' }, 403);
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
        return badRequest(
          c,
          `sort must be one of: ${CONTENT_SORT_FIELDS.join(', ')} (prefix with "-" for descending)`,
        ).response;
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
      // Custom fields and terms cost extra queries, so a list returns them only when asked for.
      const shown = await present(items, {
        meta: fields.value?.includes('meta') ?? false,
        terms: fields.value?.includes('terms') ?? false,
      });
      return respond(c, 'content:list', 200, {
        items: shown.map((item) => pick(item, fields.value)),
        total,
        limit: limit.value ?? DEFAULT_LIST_LIMIT,
        offset: offset.value ?? 0,
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.get('/content/:type/:id', async (c) => {
    const fields = parseFields(c, selectableFields);
    if (!fields.ok) return fields.response;
    const found = await find(c);
    if (!found) return notFound(c);
    const [shown] = await present([found.item], { meta: true, terms: true });
    return respond(c, 'content:get', 200, { item: pick(shown!, fields.value) });
  });

  routes.post('/content/:type', async (c) => {
    const type = c.req.param('type');
    if (!types.has(type)) return c.json({ error: 'unknown_content_type' }, 404);
    const user = userOf(c);
    const caps = capabilitiesFor(type);
    if (!(await can(user, caps.edit))) return c.json({ error: 'forbidden' }, 403);

    const raw = await readJsonObject(c);
    if (!raw.ok) return raw.response;
    const split = splitWrite(c, raw.value, { meta: !!meta, terms: !!taxonomies });
    if (!split.ok) return split.response;
    const input = parseWrite(c, split.value.core);
    if (!input.ok) return input.response;
    const { extra } = split.value;
    if (extra.terms !== undefined && !(await can(user, 'manage_categories'))) {
      return c.json({ error: 'forbidden' }, 403);
    }

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
    const checked = await checkExtra(c, type, extra, true);
    if (!checked.ok) return checked.response;
    try {
      const create: CreateContentInput = { ...input.value, type };
      const item = await content.create(create, { userId: user.id });
      try {
        await applyExtra(item.id, extra, checked.value);
      } catch (error) {
        // Do not leave an item behind that is missing the fields or terms it was created with.
        await content.delete(item.id).catch(() => undefined);
        throw error;
      }
      const [shown] = await present([item], { meta: true, terms: true });
      return respond(c, 'content:create', 201, { item: shown! });
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
    const split = splitWrite(c, raw.value, { meta: !!meta, terms: !!taxonomies });
    if (!split.ok) return split.response;
    const input = parseWrite(c, split.value.core);
    if (!input.ok) return input.response;
    const { extra } = split.value;
    if (extra.terms !== undefined && !(await can(user, 'manage_categories'))) {
      return c.json({ error: 'forbidden' }, 403);
    }

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
    const checked = await checkExtra(c, item.type, extra, false);
    if (!checked.ok) return checked.response;
    try {
      const updated = await content.update(item.id, input.value, { userId: user.id });
      await applyExtra(updated.id, extra, checked.value);
      const [shown] = await present([updated], { meta: true, terms: true });
      return respond(c, 'content:update', 200, { item: shown! });
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
      const [shown] = await present([trashed], { meta: true, terms: true });
      return respond(c, 'content:trash', 200, { item: shown! });
    } catch (error) {
      return failure(c, error);
    }
  });

  // The saved versions of an item, newest first. A revision holds the whole item as it was
  // (including an unpublished draft's text), so it needs the same rights as editing the item;
  // anonymous callers never see it, even when public reads are on.
  routes.get('/content/:type/:id/revisions', async (c) => {
    if (c.get('principal') === null) return c.json({ error: 'unauthorized' }, 401);
    const found = await find(c);
    if (!found) return notFound(c);
    const user = userOf(c);
    const { item, caps } = found;
    if (!(await can(user, caps.edit))) return c.json({ error: 'forbidden' }, 403);
    if (item.authorId !== user.id && !(await can(user, caps.editOthers))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const revisions = await content.listRevisions(item.id);
    return respond(c, 'content:revisions', 200, {
      revisions: revisions
        .map((revision) => ({
          id: revision.id,
          contentId: revision.contentId,
          authorId: revision.authorId,
          createdAt: revision.createdAt.toISOString(),
          snapshot: revision.snapshot,
        }))
        .sort((a, b) => b.id - a.id),
    });
  });

  routes.get('/openapi.json', async (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.json(
      createOpenApiDocument(types, {
        meta: !!meta,
        taxonomies: taxonomies?.listTaxonomies().map((t) => ({
          name: t.name,
          contentTypes: t.contentTypes,
        })),
        publicReads: await publicReadsEnabled(),
      }),
    );
  });

  return routes;
}

/** The JSON Schema of one custom field's value, as the content type registry validates it. */
function fieldJsonSchema(field: FieldDefinition): Record<string, unknown> {
  const one = (): Record<string, unknown> => {
    switch (field.type) {
      case 'text':
        return {
          type: 'string',
          ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
        };
      case 'richtext':
        return { type: 'array', items: { $ref: '#/components/schemas/Block' } };
      case 'number':
        return {
          type: field.integer ? 'integer' : 'number',
          ...(field.min !== undefined ? { minimum: field.min } : {}),
          ...(field.max !== undefined ? { maximum: field.max } : {}),
        };
      case 'boolean':
        return { type: 'boolean' };
      case 'date':
        return { type: 'string', format: 'date-time' };
      case 'select':
        return { type: 'string', enum: [...field.options] };
      case 'media':
      case 'relation':
        return { type: 'integer', minimum: 1 };
    }
  };
  const multiple = 'multiple' in field && field.multiple === true;
  const schema = multiple ? { type: 'array', items: one() } : one();
  return {
    ...schema,
    ...(field.description ? { description: field.description } : {}),
    ...('default' in field && field.default !== undefined ? { default: field.default } : {}),
  };
}

export interface OpenApiFeatures {
  /** Custom fields are enabled: describe `meta` for every content type. */
  meta?: boolean;
  /** Taxonomies that can be assigned; leave out when terms are not enabled. */
  taxonomies?: { name: string; contentTypes: string[] | null }[] | undefined;
  /** Anonymous reads of published items are switched on right now. */
  publicReads?: boolean;
}

/** OpenAPI 3.1 description of the content API, listing the content types registered right now. */
export function createOpenApiDocument(
  types: ContentTypeRegistry,
  features: OpenApiFeatures = {},
): Record<string, unknown> {
  const withMeta = features.meta === true;
  const withTerms = features.taxonomies !== undefined;
  const metaSchemas: Record<string, unknown> = {};
  const metaSchemaOf = (name: string) => `ContentMeta_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
  if (withMeta) {
    for (const type of types.list()) {
      const required = type.fields.filter((f) => f.required === true).map((f) => f.name);
      metaSchemas[metaSchemaOf(type.name)] = {
        type: 'object',
        additionalProperties: false,
        description:
          `Custom fields of \`${type.name}\`. On create, required fields must be sent ` +
          '(fields with a default are filled in); on update, send only the fields to change, ' +
          'and `null` clears a field that is not required.',
        ...(required.length > 0 ? { required } : {}),
        properties: Object.fromEntries(
          type.fields.map((f) => {
            const schema = fieldJsonSchema(f);
            return [f.name, f.required ? schema : { anyOf: [schema, { type: 'null' }] }];
          }),
        ),
      };
    }
  }
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
    description:
      'Comma-separated list of fields to return.' +
      (withMeta || withTerms
        ? ' A single item always includes ' +
          [withMeta ? '`meta`' : '', withTerms ? '`terms`' : ''].filter(Boolean).join(' and ') +
          '; a list includes them only when named here.'
        : ''),
    schema: {
      type: 'string',
      example: ['id', 'title', 'slug', ...(withMeta ? ['meta'] : [])].join(','),
    },
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
  // With public reads on, the two read routes also work with no credentials (`{}`).
  const readSecurity = features.publicReads === true ? [{ bearerAuth: [] }, {}] : security;
  const termIds = withTerms
    ? {
        type: 'object',
        additionalProperties: false,
        description:
          'Taxonomy name to the ids of the terms the item should have in it; each list replaces ' +
          "the item's terms in that taxonomy. Needs the `manage_categories` capability.",
        properties: Object.fromEntries(
          (features.taxonomies ?? []).map((t) => [
            t.name,
            {
              type: 'array',
              items: { type: 'integer', minimum: 1 },
              maxItems: MAX_TERMS_PER_ASSIGNMENT,
              ...(t.contentTypes ? { description: `Only for: ${t.contentTypes.join(', ')}.` } : {}),
            },
          ]),
        ),
      }
    : undefined;

  return {
    openapi: '3.1.0',
    info: {
      title: 'NodePress content API',
      version: '1.0.0',
      description:
        'Authenticate with `Authorization: Bearer <api token>`. Browser sessions also work and ' +
        'need an `X-CSRF-Token` header on writes. Non-published items are visible only to their ' +
        "author and to users who may edit others' items." +
        (features.publicReads === true
          ? ' Anonymous requests may read published items (the `api_public_read` setting is on).'
          : ' Anonymous reads of published items can be switched on with the `api_public_read` setting.'),
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
          security: readSecurity,
          parameters: [
            typeParam,
            {
              name: 'status',
              in: 'query',
              description:
                'Comma-separated statuses. Defaults to every status except trash for users who ' +
                "may edit others' items, and to `published` for everyone else.",
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
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_LIST_LIMIT,
                default: DEFAULT_LIST_LIMIT,
              },
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
            "Needs the type's edit capability, plus its publish capability for any status other than `draft`.",
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
      '/api/v1/content/{type}/{id}/revisions': {
        get: {
          operationId: 'listContentRevisions',
          summary: 'List the saved versions of an item',
          description:
            "Newest first. Needs the type's edit capability (and the edit-others capability for items by other authors). Anonymous requests are always refused.",
          security,
          parameters: [typeParam, idParam],
          responses: {
            '200': {
              description: 'The revisions.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['revisions'],
                    properties: { revisions: { type: 'array', items: ref('Revision') } },
                  },
                },
              },
            },
            '401': unauthorized,
            '403': forbidden,
            '404': missing,
          },
        },
      },
      '/api/v1/content/{type}/{id}': {
        get: {
          operationId: 'getContent',
          summary: 'Get an item',
          security: readSecurity,
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
        Revision: {
          type: 'object',
          required: ['id', 'contentId', 'authorId', 'createdAt', 'snapshot'],
          properties: {
            id: { type: 'integer' },
            contentId: { type: 'integer' },
            authorId: { type: ['integer', 'null'] },
            createdAt: { type: 'string', format: 'date-time' },
            snapshot: {
              type: 'object',
              description: 'The editable fields as they were saved.',
              required: ['title', 'slug', 'status', 'body', 'excerpt', 'publishedAt'],
              properties: {
                title: { type: 'string' },
                slug: { type: 'string' },
                status: { type: 'string' },
                body: { type: 'array', items: ref('Block') },
                excerpt: { type: ['string', 'null'] },
                authorId: { type: ['integer', 'null'] },
                parentId: { type: ['integer', 'null'] },
                publishedAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
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
            ...(withMeta
              ? {
                  meta: {
                    type: 'object',
                    additionalProperties: true,
                    description:
                      'Values of the custom fields the content type defines (see ' +
                      '`ContentMeta_<type>`). Fields without a value are absent.',
                  },
                }
              : {}),
            ...(withTerms
              ? {
                  terms: {
                    type: 'object',
                    description:
                      'Taxonomy name to the terms the item has in it. Every taxonomy that ' +
                      'applies to the content type is listed, with an empty list when unused.',
                    additionalProperties: { type: 'array', items: ref('Term') },
                  },
                }
              : {}),
          },
        },
        ...(withTerms
          ? {
              Term: {
                type: 'object',
                required: ['id', 'name', 'slug', 'parentId'],
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  parentId: { type: ['integer', 'null'] },
                },
              },
            }
          : {}),
        ...metaSchemas,
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
              description:
                'Defaults to the caller. Assigning someone else needs the edit-others capability.',
            },
            parentId: { type: ['integer', 'null'] },
            publishedAt: { type: ['string', 'null'], format: 'date-time' },
            ...(withMeta
              ? {
                  meta: {
                    description:
                      "Custom field values; the schema that applies is the item's content type's.",
                    anyOf: types.list().map((t) => ref(metaSchemaOf(t.name))),
                  },
                }
              : {}),
            ...(termIds ? { terms: termIds } : {}),
          },
        },
      },
    },
  };
}
