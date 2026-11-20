import {
  checkMailUrl,
  createLogMailAdapter,
  createSmtpMailAdapter,
  isEmailAddress,
  type Logger,
  type MailAdapter,
  type SmtpTransport,
} from '@nodepress/core';

export interface MailEnv {
  MAIL_URL?: string | undefined;
  MAIL_FROM?: string | undefined;
}

/** Makes an SMTP transport from a `MAIL_URL`. The default one uses `nodemailer`. */
export type TransportFactory = (url: string) => Promise<SmtpTransport>;

const nodemailerTransport: TransportFactory = async (url) => {
  // The name is not a literal so that the server still starts (and type-checks) without types.
  const name = 'nodemailer';
  const mod = (await import(name)) as {
    default?: { createTransport(url: string): SmtpTransport };
    createTransport?: (url: string) => SmtpTransport;
  };
  const create = mod.createTransport ?? mod.default?.createTransport;
  if (!create) throw new Error('nodemailer has no createTransport');
  return create(url);
};

/**
 * Chooses the mail adapter from the environment: `MAIL_URL` (`smtp://user:password@host:587`,
 * `smtps://` for TLS from the start) with `MAIL_FROM` (the sender address) sends real mail; without
 * them, or when they are wrong (a warning says why), messages are only logged so the site keeps
 * working.
 */
export async function createMailFromEnv(
  env: MailEnv,
  logger: Logger,
  createTransport: TransportFactory = nodemailerTransport,
): Promise<MailAdapter> {
  const fallback = createLogMailAdapter(logger);
  if (!env.MAIL_URL) return fallback;
  const problem = checkMailUrl(env.MAIL_URL);
  if (problem) {
    logger.warn(`${problem}; mail will only be logged.`);
    return fallback;
  }
  const from = env.MAIL_FROM ?? '';
  if (!isEmailAddress(from)) {
    logger.warn('MAIL_FROM must be the sender address (for example site@example.com); mail will only be logged.');
    return fallback;
  }
  try {
    return createSmtpMailAdapter({ transport: await createTransport(env.MAIL_URL), from });
  } catch (error) {
    logger.warn(`Mail could not be set up (${String(error)}); mail will only be logged.`);
    return fallback;
  }
}
