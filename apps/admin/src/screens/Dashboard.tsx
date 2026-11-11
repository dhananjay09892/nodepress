import { useSuspenseQuery } from '@tanstack/react-query';
import { sessionQuery } from '../session.js';

export function Dashboard() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-2 text-slate-700">
        Welcome, {session?.user.displayName}. Your role is {session?.user.role}.
      </p>
    </section>
  );
}
