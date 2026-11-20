import { describe, expect, it } from 'vitest';
import { checkMailUrl, createSmtpMailAdapter, type SmtpTransport } from './mail.js';

function fake() {
  const sent: Array<Parameters<SmtpTransport['sendMail']>[0]> = [];
  let fail: Error | undefined;
  const transport: SmtpTransport = {
    async sendMail(message) {
      if (fail) throw fail;
      sent.push(message);
    },
  };
  return {
    transport,
    sent,
    failWith(error: Error) {
      fail = error;
    },
  };
}

describe('createSmtpMailAdapter', () => {
  it('hands the message to the transport with the configured sender', async () => {
    const t = fake();
    const adapter = createSmtpMailAdapter({ transport: t.transport, from: 'site@example.com' });
    await adapter.send({
      to: 'owner@example.com',
      replyTo: 'jane@example.com',
      subject: 'Hello',
      text: 'Body',
    });
    expect(t.sent).toEqual([
      {
        from: 'site@example.com',
        to: 'owner@example.com',
        replyTo: 'jane@example.com',
        subject: 'Hello',
        text: 'Body',
      },
    ]);
  });

  it('leaves out replyTo when there is none', async () => {
    const t = fake();
    await createSmtpMailAdapter({ transport: t.transport, from: 'a@b.co' }).send({
      to: 'c@d.co',
      subject: 's',
      text: 't',
    });
    expect(t.sent[0]).not.toHaveProperty('replyTo');
  });

  it('removes line breaks from the subject and refuses addresses that could add headers', async () => {
    const t = fake();
    const adapter = createSmtpMailAdapter({ transport: t.transport, from: 'a@b.co' });
    await adapter.send({ to: 'c@d.co', subject: 'Hi\r\nBcc: x@y.co', text: 't' });
    expect(t.sent[0]!.subject).toBe('Hi Bcc: x@y.co');
    await expect(
      adapter.send({ to: 'c@d.co\r\nBcc: x@y.co', subject: 's', text: 't' }),
    ).rejects.toThrow(RangeError);
    await expect(
      adapter.send({ to: 'c@d.co', replyTo: 'Eve <e@x.co>', subject: 's', text: 't' }),
    ).rejects.toThrow(RangeError);
    expect(t.sent).toHaveLength(1);
  });

  it('passes transport failures on, and refuses a bad sender', async () => {
    const t = fake();
    t.failWith(new Error('connection refused'));
    await expect(
      createSmtpMailAdapter({ transport: t.transport, from: 'a@b.co' }).send({
        to: 'c@d.co',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow('connection refused');
    expect(() => createSmtpMailAdapter({ transport: t.transport, from: 'nope' })).toThrow(
      RangeError,
    );
  });
});

describe('checkMailUrl', () => {
  it('accepts smtp and smtps addresses', () => {
    expect(checkMailUrl('smtp://user:pw@mail.example.com:587')).toBeNull();
    expect(checkMailUrl('smtps://mail.example.com')).toBeNull();
  });
  it('explains what is wrong', () => {
    expect(checkMailUrl('not a url')).toMatch(/not a valid/);
    expect(checkMailUrl('http://mail.example.com')).toMatch(/smtp:\/\//);
    expect(checkMailUrl('smtp://mail.example.com:abc')).toMatch(/valid|port/);
  });
});
