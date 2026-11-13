import { z } from 'zod';
import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';

export const FIELD_TYPES = [
  'text',
  'richtext',
  'number',
  'boolean',
  'date',
  'select',
  'media',
  'relation',
] as const;
export type FieldTypeName = (typeof FIELD_TYPES)[number];

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const TYPE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;
export const MAX_FIELDS_PER_TYPE = 100;
export const MAX_TEXT_LENGTH = 100_000;
export const MAX_SELECT_OPTIONS = 200;
export const MAX_MULTIPLE_VALUES = 1000;

interface FieldBase {
  /** Key under which the value is stored (`snake_case`). */
  name: string;
  label?: string;
  description?: string;
  required?: boolean;
}

export interface TextField extends FieldBase {
  type: 'text';
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
  /** Regular expression source the value must match. */
  pattern?: string;
  default?: string;
}
export interface RichTextField extends FieldBase {
  type: 'richtext';
}
export interface NumberField extends FieldBase {
  type: 'number';
  min?: number;
  max?: number;
  integer?: boolean;
  default?: number;
}
export interface BooleanField extends FieldBase {
  type: 'boolean';
  default?: boolean;
}
export interface DateField extends FieldBase {
  type: 'date';
}
export interface SelectField extends FieldBase {
  type: 'select';
  options: string[];
  multiple?: boolean;
  default?: string | string[];
}
export interface MediaField extends FieldBase {
  type: 'media';
  multiple?: boolean;
}
export interface RelationField extends FieldBase {
  type: 'relation';
  /** Content type the related items belong to. */
  target: string;
  multiple?: boolean;
}

export type FieldDefinition =
  | TextField
  | RichTextField
  | NumberField
  | BooleanField
  | DateField
  | SelectField
  | MediaField
  | RelationField;

export interface ContentTypeDefinition {
  /** Lower-case identifier stored in `content.type`, e.g. `product`. */
  name: string;
  label?: string;
  labelPlural?: string;
  hierarchical?: boolean;
  fields?: FieldDefinition[];
}

export interface RegisteredContentType {
  name: string;
  label: string;
  labelPlural: string;
  hierarchical: boolean;
  fields: readonly FieldDefinition[];
  /** Built-in types cannot be replaced or removed. */
  builtin: boolean;
}

export interface FieldIssue {
  /** Dotted path of the offending value, e.g. `price` or `gallery.2`. */
  path: string;
  message: string;
}

export type ValidationResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; issues: FieldIssue[] };

export class ContentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentTypeError';
  }
}

export class UnknownContentTypeError extends ContentTypeError {
  constructor(name: string) {
    super(`Content type "${name}" is not registered`);
    this.name = 'UnknownContentTypeError';
  }
}

declare module './hooks.js' {
  interface ActionMap {
    /** A content type was registered (or re-registered on refresh). */
    'content-type:registered': [type: RegisteredContentType];
  }
  interface FilterMap {
    /**
     * Plugins add content types by appending definitions to the list. Invalid definitions are
     * logged and skipped; they never stop other types from registering.
     */
    'content-type:definitions': { value: ContentTypeDefinition[]; context: undefined };
  }
}

// ── Validation of definitions ──────────────────────────────────────────

const fieldBase = {
  name: z.string().regex(NAME_PATTERN, 'must be snake_case, starting with a letter'),
  label: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  required: z.boolean().optional(),
};

const fieldDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...fieldBase,
      type: z.literal('text'),
      multiline: z.boolean().optional(),
      minLength: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
      maxLength: z.number().int().min(1).max(MAX_TEXT_LENGTH).optional(),
      pattern: z.string().max(500).optional(),
      default: z.string().max(MAX_TEXT_LENGTH).optional(),
    })
    .strict(),
  z.object({ ...fieldBase, type: z.literal('richtext') }).strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('number'),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      integer: z.boolean().optional(),
      default: z.number().finite().optional(),
    })
    .strict(),
  z.object({ ...fieldBase, type: z.literal('boolean'), default: z.boolean().optional() }).strict(),
  z.object({ ...fieldBase, type: z.literal('date') }).strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('select'),
      options: z.array(z.string().min(1).max(200)).min(1).max(MAX_SELECT_OPTIONS),
      multiple: z.boolean().optional(),
      default: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .strict(),
  z.object({ ...fieldBase, type: z.literal('media'), multiple: z.boolean().optional() }).strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('relation'),
      target: z.string().regex(TYPE_NAME_PATTERN, 'must be a valid content type name'),
      multiple: z.boolean().optional(),
    })
    .strict(),
]);

const definitionSchema = z
  .object({
    name: z.string().regex(TYPE_NAME_PATTERN, 'must be lower-case, e.g. "product"'),
    label: z.string().min(1).max(100).optional(),
    labelPlural: z.string().min(1).max(100).optional(),
    hierarchical: z.boolean().optional(),
    fields: z.array(fieldDefinitionSchema).max(MAX_FIELDS_PER_TYPE).optional(),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('; ');
}

/** Cross-checks that a single-field schema cannot express. Returns an error message or undefined. */
function checkField(field: FieldDefinition): string | undefined {
  switch (field.type) {
    case 'text':
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        return 'minLength is greater than maxLength';
      }
      if (field.pattern !== undefined) {
        try {
          new RegExp(field.pattern);
        } catch {
          return 'pattern is not a valid regular expression';
        }
      }
      if (field.default !== undefined) return checkDefault(field);
      return undefined;
    case 'number':
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        return 'min is greater than max';
      }
      if (field.default !== undefined) return checkDefault(field);
      return undefined;
    case 'select': {
      if (new Set(field.options).size !== field.options.length) return 'options must be unique';
      if (field.default !== undefined) {
        if (Array.isArray(field.default) && !field.multiple) {
          return 'default must be a single option unless multiple is set';
        }
        return checkDefault(field);
      }
      return undefined;
    }
    case 'boolean':
      return undefined;
    default:
      return undefined;
  }
}

function checkDefault(field: FieldDefinition): string | undefined {
  const result = valueSchema(field).safeParse((field as { default?: unknown }).default);
  return result.success ? undefined : `default is invalid: ${formatIssues(result.error)}`;
}

// ── Value validation ───────────────────────────────────────────────────

type BlockInput = {
  type: string;
  attrs?: Record<string, unknown>;
  children?: BlockInput[];
  text?: string;
};
const MAX_BLOCK_DEPTH = 20;

function blockSchema(depth: number): z.ZodType<BlockInput> {
  return z.lazy(() =>
    z
      .object({
        type: z.string().min(1).max(100),
        attrs: z.record(z.unknown()).optional(),
        children:
          depth < MAX_BLOCK_DEPTH
            ? z.array(blockSchema(depth + 1)).optional()
            : z.never().optional(),
        text: z.string().max(MAX_TEXT_LENGTH).optional(),
      })
      .strict(),
  ) as z.ZodType<BlockInput>;
}

const dateValue = z.union([z.string().max(64), z.date()]).transform((v, ctx) => {
  const date = typeof v === 'string' ? new Date(v) : v;
  if (typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an ISO 8601 date' });
    return z.NEVER;
  }
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a valid date' });
    return z.NEVER;
  }
  return date.toISOString();
});

const positiveId = z.number().int().positive();

function many<T extends z.ZodTypeAny>(item: T, multiple: boolean | undefined): z.ZodTypeAny {
  return multiple ? z.array(item).max(MAX_MULTIPLE_VALUES) : item;
}

/** The Zod schema for one field's value (before required/optional handling). */
function valueSchema(field: FieldDefinition): z.ZodTypeAny {
  switch (field.type) {
    case 'text': {
      let s = z.string().max(field.maxLength ?? MAX_TEXT_LENGTH);
      if (field.minLength !== undefined) s = s.min(field.minLength);
      if (field.pattern !== undefined) s = s.regex(new RegExp(field.pattern));
      return s;
    }
    case 'richtext':
      return z.array(blockSchema(0)).max(10_000);
    case 'number': {
      let n = z.number().finite();
      if (field.integer) n = n.int();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'date':
      return dateValue;
    case 'select': {
      const options = field.options;
      const one = z.string().refine((v) => options.includes(v), {
        message: `Must be one of: ${options.join(', ')}`,
      });
      return field.multiple ? z.array(one).max(options.length) : one;
    }
    case 'media':
      return many(positiveId, field.multiple);
    case 'relation':
      return many(positiveId, field.multiple);
  }
}

function fieldSchema(field: FieldDefinition): z.ZodTypeAny {
  const value = valueSchema(field);
  return field.required ? value : value.nullish();
}

function hasDefault(field: FieldDefinition): boolean {
  return 'default' in field && (field as { default?: unknown }).default !== undefined;
}

export interface ValidateOptions {
  /** Updates: only validate the fields that are present; no required checks or defaults. */
  partial?: boolean;
}

function buildValidator(fields: readonly FieldDefinition[], partial: boolean): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let schema = fieldSchema(field);
    if (partial) schema = schema.optional();
    else if (hasDefault(field)) {
      schema = schema.default((field as { default?: unknown }).default);
    }
    shape[field.name] = schema;
  }
  return z.object(shape).strict();
}

// ── Registry ───────────────────────────────────────────────────────────

export interface ContentTypeRegistryOptions {
  hooks?: HookRegistry;
  logger?: Logger;
}

/** The featured image of a post or page: the id of an item in the media library. */
const FEATURED_IMAGE_FIELD: FieldDefinition = {
  name: 'featured_image',
  type: 'media',
  label: 'Featured image',
};

const BUILTIN_DEFINITIONS: ContentTypeDefinition[] = [
  {
    name: 'post',
    label: 'Post',
    labelPlural: 'Posts',
    hierarchical: false,
    fields: [FEATURED_IMAGE_FIELD],
  },
  {
    name: 'page',
    label: 'Page',
    labelPlural: 'Pages',
    hierarchical: true,
    fields: [FEATURED_IMAGE_FIELD],
  },
];

function normalize(def: ContentTypeDefinition, builtin: boolean): RegisteredContentType {
  const label = def.label ?? def.name.charAt(0).toUpperCase() + def.name.slice(1);
  return {
    name: def.name,
    label,
    labelPlural: def.labelPlural ?? `${label}s`,
    hierarchical: def.hierarchical ?? false,
    fields: Object.freeze(
      (def.fields ?? []).map((f) => Object.freeze({ ...f }) as FieldDefinition),
    ),
    builtin,
  };
}

/** Parse and cross-check a definition; throws ContentTypeError describing the first problem. */
export function parseContentTypeDefinition(input: unknown): ContentTypeDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success)
    throw new ContentTypeError(`Invalid content type: ${formatIssues(parsed.error)}`);
  const def = parsed.data as ContentTypeDefinition;
  const seen = new Set<string>();
  for (const field of def.fields ?? []) {
    if (seen.has(field.name)) {
      throw new ContentTypeError(
        `Invalid content type "${def.name}": duplicate field "${field.name}"`,
      );
    }
    seen.add(field.name);
    const problem = checkField(field);
    if (problem) {
      throw new ContentTypeError(
        `Invalid content type "${def.name}": field "${field.name}": ${problem}`,
      );
    }
  }
  return def;
}

/**
 * Holds the registered content types and validates field values against them.
 *
 * `post` and `page` are built in. Other types come from `register()` (code) or from the
 * `content-type:definitions` filter (plugins), which `refresh()` re-reads so that types from a
 * deactivated plugin disappear.
 */
export class ContentTypeRegistry {
  #types = new Map<string, RegisteredContentType>();
  #validators = new Map<string, z.ZodTypeAny>();
  #direct = new Map<string, RegisteredContentType>();
  #hooks: HookRegistry | undefined;
  #logger: Logger;

  constructor(options: ContentTypeRegistryOptions = {}) {
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    for (const def of BUILTIN_DEFINITIONS) {
      this.#types.set(def.name, normalize(parseContentTypeDefinition(def), true));
    }
  }

  /** Register a type directly. Throws if invalid or the name is taken. */
  register(definition: ContentTypeDefinition): RegisteredContentType {
    const type = this.#add(definition, this.#direct);
    void this.#announce(type);
    return type;
  }

  /** Remove a type registered with `register()`. Built-in types cannot be removed. */
  unregister(name: string): boolean {
    if (this.#types.get(name)?.builtin) {
      throw new ContentTypeError(`Built-in content type "${name}" cannot be removed`);
    }
    const had = this.#direct.delete(name);
    if (had) {
      this.#types.delete(name);
      this.#validators.clear();
    }
    return had;
  }

  has(name: string): boolean {
    return this.#types.has(name);
  }

  get(name: string): RegisteredContentType | undefined {
    return this.#types.get(name);
  }

  list(): RegisteredContentType[] {
    return [...this.#types.values()];
  }

  /**
   * Re-read the `content-type:definitions` filter. Types contributed by hooks are replaced by
   * whatever the filter returns now; built-in and directly registered types are untouched.
   */
  async refresh(): Promise<RegisteredContentType[]> {
    for (const [name, type] of [...this.#types]) {
      if (!type.builtin && !this.#direct.has(name)) this.#types.delete(name);
    }
    this.#validators.clear();
    if (!this.#hooks) return [];
    let definitions: unknown;
    try {
      definitions = await this.#hooks.applyFilters('content-type:definitions', []);
    } catch (error) {
      this.#logger.error('content-type:definitions filter failed', { error: String(error) });
      return [];
    }
    if (!Array.isArray(definitions)) {
      this.#logger.warn('content-type:definitions must return an array; ignoring');
      return [];
    }
    const added: RegisteredContentType[] = [];
    for (const definition of definitions) {
      try {
        const type = this.#add(definition, undefined);
        added.push(type);
      } catch (error) {
        this.#logger.warn('Skipping invalid content type from plugin', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const type of added) await this.#announce(type);
    return added;
  }

  /** Validate (and normalise) field values for a type. Never throws for bad input. */
  validate(typeName: string, input: unknown, options: ValidateOptions = {}): ValidationResult {
    const type = this.#types.get(typeName);
    if (!type) throw new UnknownContentTypeError(typeName);
    const partial = options.partial ?? false;
    const key = `${typeName}\u0000${partial ? 'p' : 'f'}`;
    let validator = this.#validators.get(key);
    if (!validator) {
      validator = buildValidator(type.fields, partial);
      this.#validators.set(key, validator);
    }
    const result = validator.safeParse(input ?? {});
    if (result.success) return { ok: true, value: result.data as Record<string, unknown> };
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.code === 'unrecognized_keys' ? `Unknown field: ${i.keys.join(', ')}` : i.message,
      })),
    };
  }

  #add(
    definition: unknown,
    direct: Map<string, RegisteredContentType> | undefined,
  ): RegisteredContentType {
    const def = parseContentTypeDefinition(definition);
    const existing = this.#types.get(def.name);
    if (existing) {
      throw new ContentTypeError(
        existing.builtin
          ? `Content type "${def.name}" is built in and cannot be replaced`
          : `Content type "${def.name}" is already registered`,
      );
    }
    const type = normalize(def, false);
    this.#types.set(type.name, type);
    this.#validators.clear();
    direct?.set(type.name, type);
    return type;
  }

  async #announce(type: RegisteredContentType): Promise<void> {
    await this.#hooks?.doAction('content-type:registered', type);
  }
}

export function createContentTypeRegistry(
  options: ContentTypeRegistryOptions = {},
): ContentTypeRegistry {
  return new ContentTypeRegistry(options);
}
