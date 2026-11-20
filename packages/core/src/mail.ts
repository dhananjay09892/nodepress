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
