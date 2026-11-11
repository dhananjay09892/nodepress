import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { describeError, login } from '../api.js';
import { sessionQuery } from '../session.js';

export function LoginScreen() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: async (session) => {
      queryClient.setQueryData(sessionQuery.queryKey, session);
      await navigate({ to: '/' });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-lg bg-white p-8 shadow"
        aria-labelledby="login-title"
      >
        <h1 id="login-title" className="text-2xl font-semibold text-slate-900">
          Sign in to NodePress
        </h1>

        {signIn.isError && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
            {describeError(signIn.error)}
          </p>
        )}

        <div className="space-y-1">
          <label htmlFor="email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-slate-400 px-3 py-2 text-slate-900"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-slate-400 px-3 py-2 text-slate-900"
          />
        </div>

        <button
          type="submit"
          disabled={signIn.isPending}
          className="w-full rounded bg-indigo-700 px-4 py-2 font-medium text-white hover:bg-indigo-800 disabled:opacity-60"
        >
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
