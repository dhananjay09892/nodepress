import type { HookRegistry } from './hooks.js';
import { slugify } from './content.js';
import { silentLogger, type Logger } from './logger.js';

export const MAX_TERM_NAME_LENGTH = 200;
export const MAX_TERM_DESCRIPTION_LENGTH = 5000;
export const MAX_TERMS_PER_ASSIGNMENT = 200;
export const DEFAULT_TERM_CONTENT_LIMIT = 20;
export const MAX_TERM_CONTENT_LIMIT = 100;

const TAXONOMY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;
const CONTENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;

/** What a plugin (or core) declares to add a taxonomy. */
export interface TaxonomyDefinition {
  /** Lower-case letters, digits, "-" or "_", starting with a letter (max 50). */
  name: string;
  label?: string;
  /** Hierarchical taxonomies (like categories) allow terms to have parents. */
  hierarchical?: boolean;
  /** Content types that can use this taxonomy. Omit for every type. */
  contentTypes?: string[];
}

export interface RegisteredTaxonomy {
  name: string;
  label: string;
  hierarchical: boolean;
  /** `null` means every content type. */
  contentTypes: string[] | null;
  builtin: boolean;
}

export interface TermRecord {
  id: number;
  taxonomy: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
}

export type Term = TermRecord;

export interface NewTermRecord {
  taxonomy: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
}

export type TermPatchRecord = Partial<Omit<NewTermRecord, 'taxonomy'>>;

/** Storage behind the taxonomy service. `@nodepress/db` provides `createTaxonomyStore()`. */
export interface TaxonomyStore {
  insertTerm(row: NewTermRecord): Promise<TermRecord>;
  findTermById(id: number): Promise<TermRecord | undefined>;
  findTermBySlug(taxonomy: string, slug: string): Promise<TermRecord | undefined>;
  /** True if another term of this taxonomy already uses the slug (ignoring `excludeId`). */
  slugExists(taxonomy: string, slug: string, excludeId?: number): Promise<boolean>;
  updateTerm(id: number, patch: TermPatchRecord): Promise<TermRecord | undefined>;
  /** Deletes the term and its content relations. */
  deleteTerm(id: number): Promise<boolean>;
  /** Move every direct child of `fromParentId` under `toParentId` (or to the top level). */
  reparentChildren(fromParentId: number, toParentId: number | null): Promise<void>;
  /** Ordered by name, then id. */
  listTerms(taxonomy: string): Promise<TermRecord[]>;
  /** The content type of an item, or `undefined` if it does not exist. */
  findContentType(contentId: number): Promise<string | undefined>;
  /** Idempotent: terms already assigned are left alone. */
  addRelations(contentId: number, termIds: number[]): Promise<void>;
  removeRelations(contentId: number, termIds: number[]): Promise<void>;
  /** Terms assigned to an item, optionally of one taxonomy. Ordered by name, then id. */
  listTermsForContent(contentId: number, taxonomy?: string): Promise<TermRecord[]>;
  /** Ids of items that have any of these terms, newest (highest id) first. */
  listContentIdsForTerms(termIds: number[], limit: number, offset: number): Promise<number[]>;
  /** How many items have each term (terms with none may be absent from the map). */
  countContentByTerm(termIds: number[]): Promise<Map<number, number>>;
}

/** A term with its children, for rendering hierarchical taxonomies. */
export interface TermNode extends Term {
  children: TermNode[];
}

export class TaxonomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyError';
  }
}

export class UnknownTaxonomyError extends TaxonomyError {
  constructor(name: string) {
    super(`Taxonomy "${name}" is not registered`);
    this.name = 'UnknownTaxonomyError';
  }
}

export class TermValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TermValidationError';
  }
}

export class TermNotFoundError extends Error {
  constructor(id: number) {
    super(`Term ${id} does not exist`);
    this.name = 'TermNotFoundError';
  }
}

declare module './hooks.js' {
  interface ActionMap {
    /** A taxonomy was registered (or re-registered on refresh). */
    'taxonomy:registered': [taxonomy: RegisteredTaxonomy];
    'term:created': [term: Term];
    'term:updated': [term: Term, previous: Term];
    'term:deleted': [term: Term];
    /** The terms of one taxonomy on an item changed. `termIds` is the full set now assigned. */
    'content:terms-changed': [
      info: {
        contentId: number;
        taxonomy: string;
        termIds: number[];
        added: number[];
        removed: number[];
      },
    ];
  }
  interface FilterMap {
    /**
     * Plugins add taxonomies by appending definitions to the list. Invalid definitions are
     * logged and skipped; they never stop other taxonomies from registering.
     */
    'taxonomy:definitions': { value: TaxonomyDefinition[]; context: undefined };
  }
}

const BUILTIN_DEFINITIONS: TaxonomyDefinition[] = [
  { name: 'category', label: 'Categories', hierarchical: true, contentTypes: ['post'] },
  { name: 'tag', label: 'Tags', hierarchical: false, contentTypes: ['post'] },
];

function normalizeDefinition(input: unknown, builtin: boolean): RegisteredTaxonomy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TaxonomyError('A taxonomy definition must be an object');
  }
  const def = input as Record<string, unknown>;
  if (typeof def.name !== 'string' || !TAXONOMY_NAME_PATTERN.test(def.name)) {
    throw new TaxonomyError(
      'Taxonomy name must be lower-case letters, digits, "-" or "_", starting with a letter (max 50)',
    );
  }
  if (def.label !== undefined && (typeof def.label !== 'string' || def.label.length > 200)) {
    throw new TaxonomyError(`Taxonomy "${def.name}": label must be a string of at most 200`);
  }
  if (def.hierarchical !== undefined && typeof def.hierarchical !== 'boolean') {
    throw new TaxonomyError(`Taxonomy "${def.name}": hierarchical must be a boolean`);
  }
  let contentTypes: string[] | null = null;
  if (def.contentTypes !== undefined) {
    if (
      !Array.isArray(def.contentTypes) ||
      !def.contentTypes.every((t) => typeof t === 'string' && CONTENT_TYPE_PATTERN.test(t))
    ) {
      throw new TaxonomyError(`Taxonomy "${def.name}": contentTypes must be a list of type names`);
    }
    contentTypes = [...new Set(def.contentTypes as string[])];
  }
  return {
    name: def.name,
    label: typeof def.label === 'string' && def.label.trim() ? def.label.trim() : def.name,
    hierarchical: def.hierarchical === true,
    contentTypes,
    builtin,
  };
}

export interface TaxonomyServiceOptions {
  store: TaxonomyStore;
  hooks: HookRegistry;
  logger?: Logger;
}

export interface CreateTermInput {
  taxonomy: string;
  name: string;
  /** Generated from the name when omitted. Always made unique within the taxonomy. */
  slug?: string;
  description?: string | null;
  /** Only for hierarchical taxonomies. */
  parentId?: number | null;
}

export type UpdateTermInput = Partial<Omit<CreateTermInput, 'taxonomy'>>;

export interface ListTermContentOptions {
  /** Also match items that have a descendant of the term (hierarchical taxonomies). Default true. */
  includeDescendants?: boolean;
  limit?: number;
  offset?: number;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Taxonomies (categories, tags and custom ones), their terms, and which terms are assigned to
 * which content. `category` and `tag` are built in; other taxonomies come from `register()` or
 * from the `taxonomy:definitions` filter (plugins), which `refresh()` re-reads so that taxonomies
 * from a deactivated plugin disappear. Existing terms of a vanished taxonomy stay in the database
 * but cannot be used until it is registered again.
 */
export class TaxonomyService {
  readonly #store: TaxonomyStore;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #taxonomies = new Map<string, RegisteredTaxonomy>();
  readonly #direct = new Map<string, RegisteredTaxonomy>();

  constructor(options: TaxonomyServiceOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    for (const def of BUILTIN_DEFINITIONS) {
      const taxonomy = normalizeDefinition(def, true);
      this.#taxonomies.set(taxonomy.name, taxonomy);
    }
  }

  // ── Registry ─────────────────────────────────────────────────────────

  /** Register a taxonomy directly. Throws if invalid or the name is taken. */
  register(definition: TaxonomyDefinition): RegisteredTaxonomy {
    const taxonomy = this.#add(definition, this.#direct);
    void this.#announce(taxonomy);
    return taxonomy;
  }

  /** Remove a taxonomy registered with `register()`. Built-in taxonomies cannot be removed. */
  unregister(name: string): boolean {
    if (this.#taxonomies.get(name)?.builtin) {
      throw new TaxonomyError(`Built-in taxonomy "${name}" cannot be removed`);
    }
    const had = this.#direct.delete(name);
    if (had) this.#taxonomies.delete(name);
    return had;
  }

  hasTaxonomy(name: string): boolean {
    return this.#taxonomies.has(name);
  }

  getTaxonomy(name: string): RegisteredTaxonomy | undefined {
    return this.#taxonomies.get(name);
  }

  listTaxonomies(): RegisteredTaxonomy[] {
    return [...this.#taxonomies.values()];
  }

  /**
   * Re-read the `taxonomy:definitions` filter. Taxonomies contributed by hooks are replaced by
   * whatever the filter returns now; built-in and directly registered ones are untouched.
   */
  async refresh(): Promise<RegisteredTaxonomy[]> {
    for (const [name, taxonomy] of [...this.#taxonomies]) {
      if (!taxonomy.builtin && !this.#direct.has(name)) this.#taxonomies.delete(name);
    }
    let definitions: unknown;
    try {
      definitions = await this.#hooks.applyFilters('taxonomy:definitions', []);
    } catch (error) {
      this.#logger.error('taxonomy:definitions filter failed', { error: String(error) });
      return [];
    }
    if (!Array.isArray(definitions)) {
      this.#logger.warn('taxonomy:definitions must return an array; ignoring');
      return [];
    }
    const added: RegisteredTaxonomy[] = [];
    for (const definition of definitions) {
      try {
        added.push(this.#add(definition, undefined));
      } catch (error) {
        this.#logger.warn('Skipping invalid taxonomy from plugin', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const taxonomy of added) await this.#announce(taxonomy);
    return added;
  }

  // ── Terms: reads ─────────────────────────────────────────────────────

  async getTerm(id: number): Promise<Term | undefined> {
    if (!isId(id)) return undefined;
    return this.#store.findTermById(id);
  }

  async getTermBySlug(taxonomy: string, slug: string): Promise<Term | undefined> {
    return this.#store.findTermBySlug(taxonomy, slug);
  }

  /** Every term of a taxonomy, ordered by name. */
  async listTerms(taxonomy: string): Promise<Term[]> {
    this.#requireTaxonomy(taxonomy);
    return this.#store.listTerms(taxonomy);
  }

  /** The terms of a taxonomy as a forest, siblings ordered by name. */
  async termTree(taxonomy: string): Promise<TermNode[]> {
    const terms = await this.listTerms(taxonomy);
    const nodes = new Map<number, TermNode>(terms.map((t) => [t.id, { ...t, children: [] }]));
    const roots: TermNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  /** The ids of a term's descendants (children, grandchildren, …), without the term itself. */
  async descendantIds(termId: number): Promise<number[]> {
    const term = await this.getTerm(termId);
    if (!term) return [];
    return this.#descendantsOf(term);
  }

  /** Ancestors of a term, nearest parent first. */
  async ancestors(termId: number): Promise<Term[]> {
    const term = await this.getTerm(termId);
    if (!term) return [];
    const byId = new Map((await this.#store.listTerms(term.taxonomy)).map((t) => [t.id, t]));
    const chain: Term[] = [];
    const seen = new Set<number>([term.id]);
    let cursor = term.parentId;
    while (cursor !== null && !seen.has(cursor)) {
      const parent = byId.get(cursor);
      if (!parent) break;
      chain.push(parent);
      seen.add(parent.id);
      cursor = parent.parentId;
    }
    return chain;
  }

  /** How many items use each term of the taxonomy (zero for unused terms). */
  async termCounts(taxonomy: string): Promise<Map<number, number>> {
    const terms = await this.listTerms(taxonomy);
    const counts = await this.#store.countContentByTerm(terms.map((t) => t.id));
    return new Map(terms.map((t) => [t.id, counts.get(t.id) ?? 0]));
  }

  // ── Terms: writes ────────────────────────────────────────────────────

  async createTerm(input: CreateTermInput): Promise<Term> {
    const taxonomy = this.#requireTaxonomy(input.taxonomy);
    const fields = {
      name: this.#checkName(input.name),
      description: this.#checkDescription(input.description ?? null),
      parentId: input.parentId ?? null,
    };
    await this.#assertParent(taxonomy, fields.parentId);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = await this.#uniqueSlug(taxonomy.name, input.slug ?? '', fields.name);
      try {
        const term = await this.#store.insertTerm({ taxonomy: taxonomy.name, slug, ...fields });
        await this.#hooks.doAction('term:created', term);
        return term;
      } catch (error) {
        // Another request may have taken the slug between the check and the insert.
        lastError = error;
        if (!(await this.#store.slugExists(taxonomy.name, slug))) break;
      }
    }
    throw lastError;
  }

  /**
   * Find the term with this name (case-insensitive) or slug in the taxonomy, or create it.
   * Handy for tags typed in by name.
   */
  async findOrCreateTerm(taxonomy: string, name: string, parentId?: number | null): Promise<Term> {
    this.#requireTaxonomy(taxonomy);
    const clean = this.#checkName(name);
    const existing = await this.#store.findTermBySlug(taxonomy, slugify(clean));
    if (existing) return existing;
    const lowered = clean.toLowerCase();
    const sameName = (await this.#store.listTerms(taxonomy)).find(
      (t) => t.name.toLowerCase() === lowered,
    );
    if (sameName) return sameName;
    return this.createTerm({ taxonomy, name: clean, parentId: parentId ?? null });
  }

  async updateTerm(id: number, input: UpdateTermInput): Promise<Term> {
    const previous = await this.getTerm(id);
    if (!previous) throw new TermNotFoundError(id);
    const taxonomy = this.#requireTaxonomy(previous.taxonomy);

    const patch: TermPatchRecord = {};
    if (input.name !== undefined) patch.name = this.#checkName(input.name);
    if (input.description !== undefined) {
      patch.description = this.#checkDescription(input.description);
    }
    if (input.parentId !== undefined && input.parentId !== previous.parentId) {
      await this.#assertParent(taxonomy, input.parentId, previous);
      patch.parentId = input.parentId;
    }
    if (input.slug !== undefined) {
      const wanted = slugify(input.slug);
      if (wanted !== previous.slug) patch.slug = wanted;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = { ...patch };
      if (patch.slug !== undefined) {
        next.slug = await this.#uniqueSlug(
          previous.taxonomy,
          patch.slug,
          patch.name ?? previous.name,
          previous.id,
        );
      }
      try {
        const term = await this.#store.updateTerm(id, next);
        if (!term) throw new TermNotFoundError(id);
        if (JSON.stringify(term) !== JSON.stringify(previous)) {
          await this.#hooks.doAction('term:updated', term, previous);
        }
        return term;
      } catch (error) {
        lastError = error;
        if (!next.slug) break;
        if (!(await this.#store.slugExists(previous.taxonomy, next.slug, previous.id))) break;
      }
    }
    throw lastError;
  }

  /**
   * Delete a term. Its children move up to its parent and it is removed from every item;
   * the items themselves are untouched.
   */
  async deleteTerm(id: number): Promise<boolean> {
    const term = await this.getTerm(id);
    if (!term) return false;
    await this.#store.reparentChildren(term.id, term.parentId);
    const removed = await this.#store.deleteTerm(term.id);
    if (removed) await this.#hooks.doAction('term:deleted', term);
    return removed;
  }

  // ── Assignment ───────────────────────────────────────────────────────

  /** The terms assigned to an item, optionally of one taxonomy. */
  async getContentTerms(contentId: number, taxonomy?: string): Promise<Term[]> {
    if (!isId(contentId)) return [];
    if (taxonomy !== undefined) this.#requireTaxonomy(taxonomy);
    return this.#store.listTermsForContent(contentId, taxonomy);
  }

  /**
   * Replace the terms an item has in one taxonomy with exactly these. Every term must belong to
   * the taxonomy, and the taxonomy must allow the item's content type.
   */
  async setContentTerms(contentId: number, taxonomy: string, termIds: number[]): Promise<Term[]> {
    const wanted = await this.#validateAssignment(contentId, taxonomy, termIds);
    const current = await this.#store.listTermsForContent(contentId, taxonomy);
    const currentIds = new Set(current.map((t) => t.id));
    const added = wanted.filter((id) => !currentIds.has(id));
    const removed = [...currentIds].filter((id) => !wanted.includes(id));
    await this.#store.addRelations(contentId, added);
    await this.#store.removeRelations(contentId, removed);
    await this.#announceChange(contentId, taxonomy, added, removed);
    return this.#store.listTermsForContent(contentId, taxonomy);
  }

  /** Add terms to an item, keeping the ones it already has. */
  async assignTerms(contentId: number, taxonomy: string, termIds: number[]): Promise<Term[]> {
    const wanted = await this.#validateAssignment(contentId, taxonomy, termIds);
    const currentIds = new Set(
      (await this.#store.listTermsForContent(contentId, taxonomy)).map((t) => t.id),
    );
    const added = wanted.filter((id) => !currentIds.has(id));
    await this.#store.addRelations(contentId, added);
    await this.#announceChange(contentId, taxonomy, added, []);
    return this.#store.listTermsForContent(contentId, taxonomy);
  }

  /** Remove terms from an item. Terms it does not have are ignored. */
  async removeTerms(contentId: number, taxonomy: string, termIds: number[]): Promise<Term[]> {
    const wanted = await this.#validateAssignment(contentId, taxonomy, termIds);
    const currentIds = new Set(
      (await this.#store.listTermsForContent(contentId, taxonomy)).map((t) => t.id),
    );
    const removed = wanted.filter((id) => currentIds.has(id));
    await this.#store.removeRelations(contentId, removed);
    await this.#announceChange(contentId, taxonomy, [], removed);
    return this.#store.listTermsForContent(contentId, taxonomy);
  }

  /**
   * Replace an item's terms in a taxonomy by name, creating missing terms. For tags typed in as
   * a list. Duplicates (by slug or case-insensitive name) collapse into one term.
   */
  async setContentTermsByName(
    contentId: number,
    taxonomy: string,
    names: string[],
  ): Promise<Term[]> {
    this.#requireTaxonomy(taxonomy);
    if (!Array.isArray(names) || names.length > MAX_TERMS_PER_ASSIGNMENT) {
      throw new TermValidationError(`names must be a list of at most ${MAX_TERMS_PER_ASSIGNMENT}`);
    }
    // Check the item and the taxonomy first so a bad request creates no stray terms.
    await this.#validateAssignment(contentId, taxonomy, []);
    const ids: number[] = [];
    for (const name of names) {
      const term = await this.findOrCreateTerm(taxonomy, name);
      if (!ids.includes(term.id)) ids.push(term.id);
    }
    return this.setContentTerms(contentId, taxonomy, ids);
  }

  /**
   * Ids of the items that have a term, newest first. By default items with a descendant of the
   * term match too, so "Travel" includes items filed under "Travel › Italy".
   */
  async listContentIds(termId: number, options: ListTermContentOptions = {}): Promise<number[]> {
    const limit = options.limit ?? DEFAULT_TERM_CONTENT_LIMIT;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TERM_CONTENT_LIMIT) {
      throw new TermValidationError(`limit must be an integer from 1 to ${MAX_TERM_CONTENT_LIMIT}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new TermValidationError('offset must be a non-negative integer');
    }
    const term = await this.getTerm(termId);
    if (!term) return [];
    const ids = [term.id];
    if (options.includeDescendants !== false) ids.push(...(await this.#descendantsOf(term)));
    return this.#store.listContentIdsForTerms(ids, limit, offset);
  }

  // ── Internals ────────────────────────────────────────────────────────

  #add(
    definition: unknown,
    direct: Map<string, RegisteredTaxonomy> | undefined,
  ): RegisteredTaxonomy {
    const taxonomy = normalizeDefinition(definition, false);
    const existing = this.#taxonomies.get(taxonomy.name);
    if (existing) {
      throw new TaxonomyError(
        existing.builtin
          ? `Taxonomy "${taxonomy.name}" is built in and cannot be replaced`
          : `Taxonomy "${taxonomy.name}" is already registered`,
      );
    }
    this.#taxonomies.set(taxonomy.name, taxonomy);
    direct?.set(taxonomy.name, taxonomy);
    return taxonomy;
  }

  async #announce(taxonomy: RegisteredTaxonomy): Promise<void> {
    await this.#hooks.doAction('taxonomy:registered', taxonomy);
  }

  #requireTaxonomy(name: string): RegisteredTaxonomy {
    const taxonomy = this.#taxonomies.get(name);
    if (!taxonomy) throw new UnknownTaxonomyError(String(name));
    return taxonomy;
  }

  #checkName(name: unknown): string {
    if (typeof name !== 'string') throw new TermValidationError('name must be a string');
    const clean = name.trim().replace(/\s+/g, ' ');
    if (clean.length === 0 || clean.length > MAX_TERM_NAME_LENGTH) {
      throw new TermValidationError(`name must be 1 to ${MAX_TERM_NAME_LENGTH} characters`);
    }
    return clean;
  }

  #checkDescription(description: unknown): string | null {
    if (description === null) return null;
    if (typeof description !== 'string' || description.length > MAX_TERM_DESCRIPTION_LENGTH) {
      throw new TermValidationError(
        `description must be null or a string of at most ${MAX_TERM_DESCRIPTION_LENGTH}`,
      );
    }
    return description.trim() === '' ? null : description;
  }

  /** A parent must exist in the same hierarchical taxonomy and must not create a cycle. */
  async #assertParent(
    taxonomy: RegisteredTaxonomy,
    parentId: number | null,
    self?: Term,
  ): Promise<void> {
    if (parentId === null) return;
    if (!taxonomy.hierarchical) {
      throw new TermValidationError(`taxonomy "${taxonomy.name}" is not hierarchical`);
    }
    if (!isId(parentId)) {
      throw new TermValidationError('parentId must be null or a positive integer');
    }
    if (self && parentId === self.id) {
      throw new TermValidationError('a term cannot be its own parent');
    }
    const parent = await this.#store.findTermById(parentId);
    if (!parent || parent.taxonomy !== taxonomy.name) {
      throw new TermValidationError(`parent ${parentId} does not exist in "${taxonomy.name}"`);
    }
    if (self) {
      // Walking up from the new parent must never reach the term being moved.
      const seen = new Set<number>();
      let cursor: number | null = parent.parentId;
      while (cursor !== null && !seen.has(cursor)) {
        if (cursor === self.id) throw new TermValidationError('parentId would create a cycle');
        seen.add(cursor);
        cursor = (await this.#store.findTermById(cursor))?.parentId ?? null;
      }
    }
  }

  async #descendantsOf(term: Term): Promise<number[]> {
    const all = await this.#store.listTerms(term.taxonomy);
    const childrenOf = new Map<number, number[]>();
    for (const t of all) {
      if (t.parentId === null) continue;
      const list = childrenOf.get(t.parentId) ?? [];
      list.push(t.id);
      childrenOf.set(t.parentId, list);
    }
    const result: number[] = [];
    const seen = new Set<number>([term.id]);
    const queue = [term.id];
    while (queue.length > 0) {
      const next = queue.shift() as number;
      for (const child of childrenOf.get(next) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        result.push(child);
        queue.push(child);
      }
    }
    return result;
  }

  /** `base`, `base-2`, `base-3`… the first one no other term of the taxonomy uses. */
  async #uniqueSlug(taxonomy: string, wanted: string, name: string, excludeId?: number) {
    const base = slugify(wanted) || slugify(name) || 'term';
    let candidate = base;
    for (let n = 2; n < 1000; n++) {
      if (!(await this.#store.slugExists(taxonomy, candidate, excludeId))) return candidate;
      candidate = `${base}-${n}`;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  /** Checks the item, taxonomy and terms; returns the de-duplicated term ids. */
  async #validateAssignment(
    contentId: number,
    taxonomyName: string,
    termIds: number[],
  ): Promise<number[]> {
    const taxonomy = this.#requireTaxonomy(taxonomyName);
    if (!isId(contentId)) throw new TermValidationError('contentId must be a positive integer');
    if (
      !Array.isArray(termIds) ||
      termIds.length > MAX_TERMS_PER_ASSIGNMENT ||
      !termIds.every(isId)
    ) {
      throw new TermValidationError(
        `termIds must be a list of at most ${MAX_TERMS_PER_ASSIGNMENT} positive integers`,
      );
    }
    const type = await this.#store.findContentType(contentId);
    if (type === undefined) throw new TermValidationError(`content ${contentId} does not exist`);
    if (taxonomy.contentTypes && !taxonomy.contentTypes.includes(type)) {
      throw new TermValidationError(
        `taxonomy "${taxonomy.name}" cannot be used with content type "${type}"`,
      );
    }
    const unique = [...new Set(termIds)];
    for (const id of unique) {
      const term = await this.#store.findTermById(id);
      if (!term || term.taxonomy !== taxonomy.name) {
        throw new TermValidationError(`term ${id} does not exist in "${taxonomy.name}"`);
      }
    }
    return unique;
  }

  async #announceChange(
    contentId: number,
    taxonomy: string,
    added: number[],
    removed: number[],
  ): Promise<void> {
    if (added.length === 0 && removed.length === 0) return;
    const termIds = (await this.#store.listTermsForContent(contentId, taxonomy)).map((t) => t.id);
    await this.#hooks.doAction('content:terms-changed', {
      contentId,
      taxonomy,
      termIds,
      added,
      removed,
    });
  }
}

export function createTaxonomyService(options: TaxonomyServiceOptions): TaxonomyService {
  return new TaxonomyService(options);
}
