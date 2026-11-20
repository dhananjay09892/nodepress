import type { Logger } from './logger.js';

/** A plain-text email. Addresses are single mailboxes, already validated by the caller. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Where a reply should go (for example the person who filled in a contact form). */
  replyTo?: string;
}

/** Sends email. Implementations must throw when the message could not be handed over. */
export interface MailAdapter {
  send(message: MailMessage): Promise<void>;
}

/** Keeps messages in memory (tests and previews). */
export function createMemoryMailAdapter(): MailAdapter & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push({ ...message });
    },
  };
}

/** Writes a line to the log instead of sending anything, so a site works before email is set up. */
export function createLogMailAdapter(logger: Logger): MailAdapter {
  return {
    async send(message) {
      logger.info(
        `Mail (not sent, no mail adapter configured): "${message.subject}" to ${message.to}`,
      );
    },
  };
}

/** Whether a string is a single, plain email address (no display name, no control characters). */
export function isEmailAddress(value: string): boolean {
  return (
    value.length <= 254 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\s<>(),;:\\"]/.test(value) &&
    /^[^@]+@[^@.][^@]*\.[^@.]+$/.test(value)
  );
}

/** What the SMTP adapter needs from a mail library; `nodemailer`'s transport fits. */
export interface SmtpTransport {
  sendMail(message: {
    from: string;
    to: string;
    replyTo?: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

export interface SmtpMailAdapterOptions {
  transport: SmtpTransport;
  /** The sender address (a plain address; many providers require one they have verified). */
  from: string;
}

/**
 * Sends mail through an SMTP transport. Addresses are checked again here and line breaks are
 * removed from the subject, so a message can never add headers.
 */
export function createSmtpMailAdapter(options: SmtpMailAdapterOptions): MailAdapter {
  if (!isEmailAddress(options.from)) throw new RangeError('from must be a plain email address');
  return {
    async send(message) {
      if (!isEmailAddress(message.to)) throw new RangeError('to must be a plain email address');
      if (message.replyTo !== undefined && !isEmailAddress(message.replyTo)) {
        throw new RangeError('replyTo must be a plain email address');
      }
      await options.transport.sendMail({
        from: options.from,
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
        text: message.text,
      });
    },
  };
}

/**
 * Checks a `MAIL_URL` (`smtp://user:password@host:587` or `smtps://…` for TLS from the start).
 * Returns a problem description, or `null` when the address is usable.
 */
export function checkMailUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'MAIL_URL is not a valid address';
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    return 'MAIL_URL must start with smtp:// or smtps://';
  }
  if (!url.hostname) return 'MAIL_URL needs a host';
  if (url.port !== '' && !/^\d{1,5}$/.test(url.port)) return 'MAIL_URL has a bad port';
  return null;
}
