import { silentLogger, type Logger, type SmtpTransport } from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import { createMailFromEnv } from './mail-setup.js';

function logger() {
  const warnings: string[] = [];
  const log: Logger = { ...silentLogger, warn: (m: string) => void warnings.push(m) };
  return { log, warnings };
}

const message = { to: 'owner@example.com', subject: 'Hi', text: 'Body' };

describe('createMailFromEnv', () => {
  it('only logs when MAIL_URL is not set', async () => {
    const { log, warnings } = logger();
    const mail = await createMailFromEnv({}, log, async () => {
      throw new Error('must not be called');
    });
    await mail.send(message);
    expect(warnings).toEqual([]);
  });

  it('sends through the transport made from MAIL_URL', async () => {
    const { log, warnings } = logger();
    const sent: unknown[] = [];
    let url = '';
    const transport: SmtpTransport = { sendMail: async (m) => void sent.push(m) };
    const mail = await createMailFromEnv(
      { MAIL_URL: 'smtp://u:p@mail.example.com:587', MAIL_FROM: 'site@example.com' },
      log,
      async (u) => {
        url = u;
        return transport;
      },
    );
    await mail.send(message);
    expect(url).toBe('smtp://u:p@mail.example.com:587');
    expect(sent).toEqual([{ from: 'site@example.com', ...message }]);
    expect(warnings).toEqual([]);
  });

  it('warns and falls back when the address, the sender or the library is wrong', async () => {
    for (const [env, text] of [
      [{ MAIL_URL: 'http://x.example.com', MAIL_FROM: 'a@b.co' }, /smtp:\/\//],
      [{ MAIL_URL: 'smtp://x.example.com' }, /MAIL_FROM/],
      [{ MAIL_URL: 'smtp://x.example.com', MAIL_FROM: 'a@b.co' }, /could not be set up/],
    ] as const) {
      const { log, warnings } = logger();
      const mail = await createMailFromEnv(env, log, async () => {
        throw new Error('no library');
      });
      await mail.send(message);
      expect(warnings[0]).toMatch(text);
      expect(warnings[0]).not.toContain('p@');
    }
  });
});
