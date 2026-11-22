import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  describeMailStatus,
  describeMessagesError,
  fetchMessages,
  formatMessageDate,
  pageCount,
} from '../messages.js';
import { defineScreen } from '../screen-types.js';

const buttonClass =
  'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

function Messages() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['contact-messages', page],
    queryFn: () => fetchMessages(page),
  });
  const data = query.data;
  const pages = data ? pageCount(data.total, data.pageSize) : 1;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Messages</h1>
      <p className="text-sm text-slate-700">Messages sent through the contact form, newest first.</p>
      {query.isPending && <p className="text-sm text-slate-700">Loading…</p>}
      {query.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeMessagesError(query.error)}
        </p>
      )}
      {data && data.submissions.length === 0 && (
        <p className="rounded bg-white p-4 text-sm text-slate-700 shadow">No messages yet.</p>
      )}
      {data && data.submissions.length > 0 && (
        <div className="overflow-x-auto rounded bg-white shadow">
          <table className="w-full text-left text-sm text-slate-900">
            <caption className="sr-only">Contact messages</caption>
            <thead className="bg-slate-100 text-xs uppercase text-slate-700">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Date
                </th>
                <th scope="col" className="px-3 py-2">
                  Name
                </th>
                <th scope="col" className="px-3 py-2">
                  Email
                </th>
                <th scope="col" className="px-3 py-2">
                  Form
                </th>
                <th scope="col" className="px-3 py-2">
                  Mail
                </th>
                <th scope="col" className="px-3 py-2">
                  Message
                </th>
              </tr>
            </thead>
            <tbody>
              {data.submissions.map((m) => (
                <tr key={m.id} className="border-t border-slate-200 align-top">
                  <td className="whitespace-nowrap px-3 py-2">{formatMessageDate(m.createdAt)}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2">
                    <a className="text-blue-800 underline" href={`mailto:${encodeURIComponent(m.email)}`}>
                      {m.email}
                    </a>
                  </td>
                  <td className="px-3 py-2 font-mono">{m.form}</td>
                  <td className="px-3 py-2">{describeMailStatus(m.mailStatus)}</td>
                  <td className="whitespace-pre-wrap break-words px-3 py-2">{m.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && (
        <nav aria-label="Pages" className="flex items-center gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span className="text-sm text-slate-700">
            Page {page} of {pages} ({data.total} messages)
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

export default defineScreen({
  id: 'messages',
  path: '/messages',
  label: 'Messages',
  order: 45,
  component: Messages,
  available: fetchMessages,
});
