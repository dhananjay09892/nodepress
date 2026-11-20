import { describe, expect, it, vi } from 'vitest';
import { CONTACT_FORM_SCRIPT } from './contact-form-script.js';

/** A very small DOM, enough to run the script: one form with its fields. */
function fakeDom() {
  const listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  const makeInput = (id: string, value = '') => ({
    id,
    value,
    focus: vi.fn(),
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    removeAttribute(k: string) {
      delete this.attrs[k];
    },
  });
  const inputs = {
    name: makeInput('np-contact-name', 'Jane'),
    email: makeInput('np-contact-email', 'jane@example.com'),
    message: makeInput('np-contact-message', 'Hello'),
    website: makeInput('np-contact-website'),
  };
  const errors: Record<string, { hidden: boolean; textContent: string }> = {};
  for (const name of ['name', 'email', 'message']) {
    errors[`np-contact-${name}-error`] = { hidden: true, textContent: '' };
  }
  const status = { hidden: true, textContent: '', className: '' };
  const button = { disabled: false };
  const form = {
    elements: inputs,
    reset: vi.fn(),
    getAttribute: (k: string) =>
      k === 'data-form' ? 'sales' : k === 'data-success' ? 'Thanks!' : null,
    querySelector: (selector: string) => (selector === '.np-contact-status' ? status : button),
    addEventListener: (type: string, fn: (event: { preventDefault(): void }) => void) => {
      listeners[type] = fn;
    },
  };
  const document = {
    querySelectorAll: () => [form],
    getElementById: (id: string) => errors[id],
  };
  return { document, form, status, button, errors, inputs, listeners };
}

async function run(
  dom: ReturnType<typeof fakeDom>,
  responses: Array<{ status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; init?: { body?: string } | undefined }> = [];
  const queue = [{ status: 200, body: { token: 'tok' } }, ...responses];
  const fetchFn = async (url: string, init?: { body?: string }) => {
    calls.push({ url, init });
    const next = queue.shift()!;
    return { status: next.status, json: async () => next.body };
  };
  const window: Record<string, unknown> = {};
  new Function('window', 'document', 'fetch', 'setTimeout', 'Promise', 'Date', CONTACT_FORM_SCRIPT)(
    window,
    dom.document,
    fetchFn,
    (fn: () => void) => {
      fn();
    },
    Promise,
    Date,
  );
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  dom.listeners['submit']!({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 20));
  return calls;
}

describe('contact form script', () => {
  it('fetches a token, posts the JSON and shows the success text', async () => {
    const dom = fakeDom();
    const calls = await run(dom, [{ status: 201, body: { ok: true } }]);
    expect(calls[0]!.url).toBe('/api/v1/contact/token');
    expect(calls[1]!.url).toBe('/api/v1/contact');
    expect(JSON.parse(calls[1]!.init!.body!)).toEqual({
      form: 'sales',
      name: 'Jane',
      email: 'jane@example.com',
      message: 'Hello',
      website: '',
      token: 'tok',
    });
    expect(dom.status.textContent).toBe('Thanks!');
    expect(dom.status.className).toContain('np-contact-success');
    expect(dom.form.reset).toHaveBeenCalled();
    expect(dom.button.disabled).toBe(false);
  });

  it('shows field errors next to the fields and focuses the first one', async () => {
    const dom = fakeDom();
    await run(dom, [
      {
        status: 400,
        body: { error: 'invalid_request', fields: { email: 'Enter a valid email address.' } },
      },
    ]);
    expect(dom.errors['np-contact-email-error']).toEqual({
      hidden: false,
      textContent: 'Enter a valid email address.',
    });
    expect(dom.inputs.email.attrs['aria-invalid']).toBe('true');
    expect(dom.inputs.email.focus).toHaveBeenCalled();
    expect(dom.errors['np-contact-name-error']!.hidden).toBe(true);
  });

  it('explains a rate limit and an expired form', async () => {
    const limited = fakeDom();
    await run(limited, [{ status: 429, body: { error: 'rate_limited' } }]);
    expect(limited.status.textContent).toMatch(/Too many/);
    const expired = fakeDom();
    await run(expired, [{ status: 400, body: { error: 'bad_token' } }]);
    expect(expired.status.textContent).toMatch(/expired/);
    expect(expired.status.className).toContain('np-contact-error');
  });
});
