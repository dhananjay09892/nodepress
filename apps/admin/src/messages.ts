import { ApiError, request, toError } from './api.js';

export interface ContactMessage {
  id: number;
  form: string;
  name: string;
  email: string;
  message: string;
  mailStatus: string;
  createdAt: string;
}

export interface MessagePage {
  total: number;
  page: number;
  pageSize: number;
  submissions: ContactMessage[];
}

/**
 * One page of stored contact messages, or `null` when this user may not read them (403) or the
 * site has no contact form (404); either keeps the sidebar entry hidden.
 */
export async function fetchMessages(page = 1): Promise<MessagePage | null> {
  const res = await request(`/api/v1/contact/submissions?page=${Math.max(1, Math.floor(page))}`);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as MessagePage;
}

/** The number of pages for a result, at least one so an empty list still has a page 1. */
export function pageCount(total: number, pageSize: number): number {
  if (!(pageSize > 0)) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** A readable label for the mail status stored with a message. */
export function describeMailStatus(status: string): string {
  switch (status) {
    case 'sent':
      return 'Emailed';
    case 'failed':
      return 'Email failed';
    case 'logged':
      return 'Not emailed (logged)';
    case 'skipped':
      return 'Not emailed';
    default:
      return status || 'Unknown';
  }
}

/** The date as text in the reader's locale; the raw value when it is not a valid date. */
export function formatMessageDate(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function describeMessagesError(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'You do not have permission to read messages.';
  }
  return 'Could not load the messages. Try again.';
}
