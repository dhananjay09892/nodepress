import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { isEmailAddress, type MailAdapter } from './mail.js';
import { RateLimiter } from './rate-limit.js';

export const MAX_NAME_LENGTH = 100;
export const MAX_MESSAGE_LENGTH = 5000;
/** A form submitted faster than this was filled in by a script. */
export const MIN_FILL_MS = 3000;
/** A form older than this must be loaded again. */
export const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;
/** Name of the hidden field humans never fill in. */
export const HONEYPOT_FIELD = 'website';

export interface ContactSubmission {
  id: number;
  form: string;
  name: string;
  email: string;
  message: string;
  ipHash: string;
  mailStatus: string;
  createdAt: Date;
}

export type NewContactSubmission = Omit<ContactSubmission, 'id' | 'createdAt'>;

/** Where submissions are kept. */
export interface ContactSubmissionStore {
  insert(row: NewContactSubmission): Promise<ContactSubmission>;
  list(options: { limit: number; offset: number }): Promise<ContactSubmission[]>;
  count(): Promise<number>;
}

export interface ContactFormOptions {
  store: ContactSubmissionStore;
  /** Where messages are emailed. Without a recipient nothing is sent and the status is `skipped`. */
  to?: string | undefined;
  mail?: MailAdapter | undefined;
  /** Key for the form tokens and the address hashes. Tokens stop working when it changes. */
  secret: string;
  /** Submissions allowed per sender within `windowMs`. Default 5. */
  maxPerWindow?: number;
  /** Default one hour. */
  windowMs?: number;
  logger?: Logger;
  now?: () => number;
}

export type ContactResult =
  | { ok: true; submission: ContactSubmission | null }
  | {
      ok: false;
      error: 'invalid' | 'rate_limited' | 'bad_token';
      /** Field problems, for `invalid`. */
      fields?: Record<string, string>;
      retryAfterMs?: number;
    };

export interface ContactInput {
  name?: unknown;
  email?: unknown;
  message?: unknown;
  /** The token from `issueToken()`. */
  token?: unknown;
  /** The honeypot field. */
  [HONEYPOT_FIELD]?: unknown;
  /** Which form this is (default `contact`). */
  form?: unknown;
}

/**
 * A contact form: checks the message, rejects spam (a hidden honeypot field, a signed token that
 * proves the form was loaded a few seconds ago, and a per-sender rate limit), stores the
 * submission and emails it. A mail failure never loses the message: it is stored with status
 * `failed`.
 */
export class ContactFormService {
  readonly #options: ContactFormOptions;
  readonly #limiter: RateLimiter;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(options: ContactFormOptions) {
    if (options.secret.length < 16) throw new RangeError('secret must be at least 16 characters');
    if (options.to !== undefined && !isEmailAddress(options.to)) {
      throw new RangeError('to must be a plain email address');
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? silentLogger;
    this.#limiter = new RateLimiter({
      max: options.maxPerWindow ?? 5,
      windowMs: options.windowMs ?? 60 * 60 * 1000,
      now: this.#now,
    });
  }

  /** A token to put in the form when it is shown: the time, signed. */
  issueToken(): string {
    const issued = String(this.#now());
    return `${issued}.${this.#sign(issued)}`;
  }

  /** Hash of the sender's address, so submissions can be grouped without keeping the address. */
  hashSender(sender: string): string {
    return createHmac('sha256', this.#options.secret)
      .update(`ip:${sender}`)
      .digest('hex')
      .slice(0, 32);
  }

  async submit(input: ContactInput, sender: string): Promise<ContactResult> {
    const ipHash = this.hashSender(sender);
    const status = this.#limiter.check(ipHash);
    if (!status.allowed) {
      return { ok: false, error: 'rate_limited', retryAfterMs: status.retryAfterMs };
    }
    // Every attempt counts, good or bad, so a script cannot flood the inbox.
    this.#limiter.fail(ipHash);

    // A filled honeypot gets the same answer as success, so a bot learns nothing.
    const trap = input[HONEYPOT_FIELD];
    if (trap !== undefined && trap !== null && String(trap) !== '')
      return { ok: true, submission: null };

    if (!this.#tokenValid(input.token)) return { ok: false, error: 'bad_token' };

    const fields: Record<string, string> = {};
    const name = clean(input.name);
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    const message =
      typeof input.message === 'string' ? input.message.replace(/\r\n/g, '\n').trim() : '';
    if (!name) fields.name = 'Enter your name.';
    else if (name.length > MAX_NAME_LENGTH)
      fields.name = `Use at most ${MAX_NAME_LENGTH} characters.`;
    if (!isEmailAddress(email)) fields.email = 'Enter a valid email address.';
    if (!message) fields.message = 'Enter a message.';
    else if (message.length > MAX_MESSAGE_LENGTH) {
      fields.message = `Use at most ${MAX_MESSAGE_LENGTH} characters.`;
    }
    if (Object.keys(fields).length > 0) return { ok: false, error: 'invalid', fields };

    const form =
      typeof input.form === 'string' && /^[a-z0-9-]{1,40}$/.test(input.form)
        ? input.form
        : 'contact';
    const mailStatus = await this.#mail(form, name, email, message);
    const submission = await this.#options.store.insert({
      form,
      name,
      email,
      message,
      ipHash,
      mailStatus,
    });
    return { ok: true, submission };
  }

  async list(options: { limit: number; offset: number }) {
    const [items, total] = await Promise.all([
      this.#options.store.list(options),
      this.#options.store.count(),
    ]);
    return { items, total };
  }

  async #mail(form: string, name: string, email: string, message: string): Promise<string> {
    const { to, mail } = this.#options;
    if (!to || !mail) return 'skipped';
    try {
      await mail.send({
        to,
        replyTo: email,
        subject: `New message from ${name.replace(/[\r\n]+/g, ' ')} (${form})`,
        text: `From: ${name} <${email}>\n\n${message}\n`,
      });
      return 'sent';
    } catch (error) {
      this.#logger.warn(`Contact form mail failed: ${String(error)}`);
      return 'failed';
    }
  }

  #sign(issued: string): string {
    return createHmac('sha256', this.#options.secret).update(`token:${issued}`).digest('hex');
  }

  #tokenValid(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const [issued, signature, extra] = token.split('.');
    if (!issued || !signature || extra !== undefined || !/^\d{1,16}$/.test(issued)) return false;
    const expected = Buffer.from(this.#sign(issued));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    const age = this.#now() - Number(issued);
    return age >= MIN_FILL_MS && age <= MAX_FORM_AGE_MS;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function createContactForm(options: ContactFormOptions): ContactFormService {
  return new ContactFormService(options);
}
