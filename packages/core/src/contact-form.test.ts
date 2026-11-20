import { describe, expect, it } from 'vitest';
import {
  createContactForm,
  HONEYPOT_FIELD,
  MAX_MESSAGE_LENGTH,
  MIN_FILL_MS,
  type ContactSubmission,
  type ContactSubmissionStore,
} from './contact-form.js';
import { createMemoryMailAdapter, isEmailAddress, type MailAdapter } from './mail.js';

function memoryStore(): ContactSubmissionStore & { rows: ContactSubmission[] } {
  const rows: ContactSubmission[] = [];
  return {
    rows,
    async insert(row) {
      const saved = { ...row, id: rows.length + 1, createdAt: new Date() };
      rows.push(saved);
      return saved;
    },
    async list({ limit, offset }) {
      return [...rows].reverse().slice(offset, offset + limit);
    },
    async count() {
      return rows.length;
    },
  };
}

const SECRET = 'a-secret-of-at-least-16-chars';

function setup(extra: { to?: string; mail?: MailAdapter; maxPerWindow?: number } = {}) {
  let now = 1_000_000;
  const store = memoryStore();
  const mail = createMemoryMailAdapter();
  const form = createContactForm({
    store,
    secret: SECRET,
    to: 'owner@example.com',
    mail,
    now: () => now,
    ...extra,
  });
  return {
    form,
    store,
    mail,
    advance: (ms: number) => void (now += ms),
    /** A token that is old enough to be valid. */
    token() {
      const token = form.issueToken();
      now += MIN_FILL_MS + 1;
      return token;
    },
  };
}

const good = { name: 'Ada', email: 'ada@example.com', message: 'Hello there' };

describe('isEmailAddress', () => {
  it('accepts plain addresses and rejects odd ones', () => {
    expect(isEmailAddress('a@b.co')).toBe(true);
    expect(isEmailAddress('a.b+c@sub.example.com')).toBe(true);
    for (const bad of ['', 'a', 'a@b', 'a b@c.de', 'a@b.c\nBcc: x@y.z', '<a@b.co>', 'a@@b.co', 'a@.co']) {
      expect(isEmailAddress(bad), bad).toBe(false);
    }
  });
});

describe('ContactFormService', () => {
  it('stores a valid submission and emails it with a reply-to', async () => {
    const t = setup();
    const result = await t.form.submit({ ...good, token: t.token() }, '1.2.3.4');
    expect(result).toMatchObject({ ok: true, submission: { name: 'Ada', mailStatus: 'sent' } });
    expect(t.store.rows).toHaveLength(1);
    expect(t.mail.sent).toEqual([
      {
        to: 'owner@example.com',
        replyTo: 'ada@example.com',
        subject: 'New message from Ada (contact)',
        text: 'From: Ada <ada@example.com>\n\nHello there\n',
      },
    ]);
  });

  it('never stores the sender address, only a hash', async () => {
    const t = setup();
    await t.form.submit({ ...good, token: t.token() }, '1.2.3.4');
    const row = t.store.rows[0]!;
    expect(row.ipHash).toBe(t.form.hashSender('1.2.3.4'));
    expect(JSON.stringify(row)).not.toContain('1.2.3.4');
  });

  it('reports every invalid field', async () => {
    const t = setup();
    const result = await t.form.submit(
      { name: ' ', email: 'nope', message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1), token: t.token() },
      'ip',
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid' });
    if (!result.ok) expect(Object.keys(result.fields ?? {}).sort()).toEqual(['email', 'message', 'name']);
    expect(t.store.rows).toHaveLength(0);
    expect(t.mail.sent).toHaveLength(0);
  });

  it('answers a filled honeypot like success but stores and sends nothing', async () => {
    const t = setup();
    const result = await t.form.submit({ ...good, [HONEYPOT_FIELD]: 'http://spam', token: t.token() }, 'ip');
    expect(result).toEqual({ ok: true, submission: null });
    expect(t.store.rows).toHaveLength(0);
    expect(t.mail.sent).toHaveLength(0);
  });

  it('rejects a missing, forged, too fresh or expired token', async () => {
    const t = setup();
    expect(await t.form.submit({ ...good }, 'a')).toMatchObject({ ok: false, error: 'bad_token' });
    expect(await t.form.submit({ ...good, token: '123.abc' }, 'b')).toMatchObject({ error: 'bad_token' });
    const fresh = t.form.issueToken();
    expect(await t.form.submit({ ...good, token: fresh }, 'c')).toMatchObject({ error: 'bad_token' });
    const [issued] = fresh.split('.');
    expect(await t.form.submit({ ...good, token: `${issued}.${'0'.repeat(64)}` }, 'd')).toMatchObject({
      error: 'bad_token',
    });
    const old = t.form.issueToken();
    t.advance(25 * 60 * 60 * 1000);
    expect(await t.form.submit({ ...good, token: old }, 'e')).toMatchObject({ error: 'bad_token' });
    expect(t.store.rows).toHaveLength(0);
  });

  it('a token signed with another secret does not work', async () => {
    const t = setup();
    const other = createContactForm({
      store: memoryStore(),
      secret: 'another-secret-16-chars!',
      now: () => 1_000_000,
    });
    const foreign = other.issueToken();
    t.advance(MIN_FILL_MS + 1);
    expect(await t.form.submit({ ...good, token: foreign }, 'x')).toMatchObject({
      error: 'bad_token',
    });
  });

  it('rate limits a sender, then lets them in after the window', async () => {
    const t = setup({ maxPerWindow: 2 });
    const send = () => t.form.submit({ ...good, token: t.token() }, 'same-ip');
    expect(await send()).toMatchObject({ ok: true });
    expect(await send()).toMatchObject({ ok: true });
    const blocked = await send();
    expect(blocked).toMatchObject({ ok: false, error: 'rate_limited' });
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(await t.form.submit({ ...good, token: t.token() }, 'other-ip')).toMatchObject({ ok: true });
    t.advance(61 * 60 * 1000);
    expect(await send()).toMatchObject({ ok: true });
  });

  it('counts spam attempts against the limit too', async () => {
    const t = setup({ maxPerWindow: 2 });
    await t.form.submit({ ...good, [HONEYPOT_FIELD]: 'x', token: t.token() }, 'bot');
    await t.form.submit({ ...good, [HONEYPOT_FIELD]: 'x', token: t.token() }, 'bot');
    expect(await t.form.submit({ ...good, token: t.token() }, 'bot')).toMatchObject({ error: 'rate_limited' });
  });

  it('keeps the message when email fails, and skips email without a recipient', async () => {
    const failing: MailAdapter = {
      async send() {
        throw new Error('smtp down');
      },
    };
    const t = setup({ mail: failing });
    expect(await t.form.submit({ ...good, token: t.token() }, 'a')).toMatchObject({
      ok: true,
      submission: { mailStatus: 'failed' },
    });
    const none = createContactForm({ store: memoryStore(), secret: SECRET, now: () => 5_000_000 });
    const token = none.issueToken();
    const later = createContactForm({ store: memoryStore(), secret: SECRET, now: () => 5_000_000 + MIN_FILL_MS + 1 });
    expect(await later.submit({ ...good, token }, 'a')).toMatchObject({ submission: { mailStatus: 'skipped' } });
  });

  it('cannot be tricked into header injection through the name', async () => {
    const t = setup();
    await t.form.submit({ ...good, name: 'Ada\r\nBcc: evil@example.com', token: t.token() }, 'a');
    expect(t.mail.sent[0]!.subject).not.toMatch(/[\r\n]/);
    expect(t.mail.sent[0]!.to).toBe('owner@example.com');
  });

  it('lists newest first with a total', async () => {
    const t = setup();
    await t.form.submit({ ...good, name: 'One', token: t.token() }, 'a');
    await t.form.submit({ ...good, name: 'Two', token: t.token() }, 'b');
    const { items, total } = await t.form.list({ limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(items.map((i) => i.name)).toEqual(['Two', 'One']);
  });

  it('refuses a weak secret or an odd recipient', () => {
    expect(() => createContactForm({ store: memoryStore(), secret: 'short' })).toThrow(RangeError);
    expect(() => createContactForm({ store: memoryStore(), secret: SECRET, to: 'a b' })).toThrow(RangeError);
  });
});
