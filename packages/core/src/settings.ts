import type { OptionsService } from './options.js';
import { MAX_PATTERN_LENGTH, parsePattern, DEFAULT_POST_PATTERN } from './permalinks.js';

declare module './options.js' {
  interface OptionMap {
    /** Name of the site. */
    site_title: string;
    /** Short description shown under the name. */
    tagline: string;
    /** IANA time zone name, e.g. `Europe/Berlin`. */
    timezone: string;
    /** Id of the page shown at `/`, or `null` for the latest posts. */
    front_page_id: number | null;
    /** How many posts a list page shows. */
    posts_per_page: number;
    /** Ask search engines not to index the site. */
    discourage_search_engines: boolean;
  }
}

export const MAX_SITE_TITLE_LENGTH = 200;
export const MAX_TAGLINE_LENGTH = 300;
export const MAX_POSTS_PER_PAGE = 100;

/** The settings the settings API knows. Each is stored as the option of the same name. */
export interface Settings {
  site_title: string;
  tagline: string;
  timezone: string;
  front_page_id: number | null;
  posts_per_page: number;
  discourage_search_engines: boolean;
  permalink_structure: string;
  api_public_read: boolean;
}

export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: Readonly<Settings> = {
  site_title: 'NodePress',
  tagline: '',
  timezone: 'UTC',
  front_page_id: null,
  posts_per_page: 10,
  discourage_search_engines: false,
  permalink_structure: DEFAULT_POST_PATTERN,
  api_public_read: false,
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_DEFAULTS, key);
}

/** A value for one setting was refused; `key` says which and `message` why. */
export class SettingValidationError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'SettingValidationError';
  }
}

export interface SettingsServiceOptions {
  options: OptionsService;
  /**
   * Whether `id` is a published page, so `front_page_id` can only point at one.
   * Without it only the shape of the id is checked.
   */
  isPublishedPage?: (id: number) => Promise<boolean>;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function text(key: string, value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new SettingValidationError(key, `${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new SettingValidationError(
      key,
      min === 0
        ? `${key} must be at most ${max} characters`
        : `${key} must be ${min} to ${max} characters`,
    );
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new SettingValidationError(key, `${key} cannot contain control characters`);
  }
  return trimmed;
}

function bool(key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SettingValidationError(key, `${key} must be a boolean`);
  return value;
}

function timezone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new SettingValidationError('timezone', 'timezone must be an IANA time zone name');
  }
  try {
    // Throws a RangeError for a name it does not know; resolves the canonical spelling.
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new SettingValidationError('timezone', `"${value}" is not a known time zone`);
  }
}

function permalink(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATTERN_LENGTH) {
    throw new SettingValidationError(
      'permalink_structure',
      `permalink_structure must be a pattern of 1 to ${MAX_PATTERN_LENGTH} characters`,
    );
  }
  try {
    return parsePattern(value).pattern;
  } catch (error) {
    throw new SettingValidationError(
      'permalink_structure',
      error instanceof Error ? error.message : 'invalid permalink pattern',
    );
  }
}

/**
 * Read and change the site settings behind `/api/v1/settings`.
 *
 * A fixed list of keys, each validated on its own. `update()` checks every value before it
 * writes any, so a bad value never leaves the settings half changed. Everything is stored
 * through the options service, so `option:updated` fires and other code sees the new values.
 */
export class SettingsService {
  readonly #options: OptionsService;
  readonly #isPublishedPage: ((id: number) => Promise<boolean>) | undefined;

  constructor(opts: SettingsServiceOptions) {
    this.#options = opts.options;
    this.#isPublishedPage = opts.isPublishedPage;
  }

  /** Every setting, with the default for any that was never saved or whose stored value is invalid. */
  async getAll(): Promise<Settings> {
    const result: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      const stored = await this.#options.get(key);
      result[key] = stored === undefined || !this.#valid(key, stored) ? SETTING_DEFAULTS[key] : stored;
    }
    return result as unknown as Settings;
  }

  /**
   * Validate and save the given settings. Throws `SettingValidationError` for an unknown key or
   * a bad value; nothing is saved then. Returns all settings after the change.
   */
  async update(patch: Record<string, unknown>): Promise<Settings> {
    const clean: Partial<Record<SettingKey, unknown>> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!isSettingKey(key)) throw new SettingValidationError(key, `Unknown setting "${key}"`);
      clean[key] = await this.#validate(key, value);
    }
    for (const [key, value] of Object.entries(clean)) {
      await this.#options.set(key, value);
    }
    return this.getAll();
  }

  #valid(key: SettingKey, value: unknown): boolean {
    try {
      return this.#shape(key, value) !== undefined;
    } catch {
      return false;
    }
  }

  /** Check the value without looking anything up; `undefined` is never a valid result. */
  #shape(key: SettingKey, value: unknown): unknown {
    switch (key) {
      case 'site_title':
        return text(key, value, 1, MAX_SITE_TITLE_LENGTH);
      case 'tagline':
        return text(key, value, 0, MAX_TAGLINE_LENGTH);
      case 'timezone':
        return timezone(value);
      case 'front_page_id':
        if (value === null) return null;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
          throw new SettingValidationError(key, 'front_page_id must be a page id or null');
        }
        return value;
      case 'posts_per_page':
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > MAX_POSTS_PER_PAGE
        ) {
          throw new SettingValidationError(
            key,
            `posts_per_page must be a whole number from 1 to ${MAX_POSTS_PER_PAGE}`,
          );
        }
        return value;
      case 'discourage_search_engines':
      case 'api_public_read':
        return bool(key, value);
      case 'permalink_structure':
        return permalink(value);
    }
  }

  async #validate(key: SettingKey, value: unknown): Promise<unknown> {
    const checked = this.#shape(key, value);
    if (key === 'front_page_id' && checked !== null && this.#isPublishedPage) {
      if (!(await this.#isPublishedPage(checked as number))) {
        throw new SettingValidationError(key, 'front_page_id must be a published page');
      }
    }
    return checked;
  }
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  return new SettingsService(options);
}
