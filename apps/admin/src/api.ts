export interface SessionUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
}

/** The signed-in user plus the CSRF token to send with every cookie-authenticated write. */
export interface Session {
  user: SessionUser;
  csrfToken: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
}

async function toError(res: Response): Promise<ApiError> {
  let code = 'request_failed';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    // Not JSON (for example a proxy error page); keep the generic code.
  }
  return new ApiError(res.status, code);
}

/** The current session, or `null` when nobody is signed in. */
export async function fetchSession(): Promise<Session | null> {
  const res = await request('/api/v1/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { user: SessionUser; csrfToken: string };
  return { user: body.user, csrfToken: body.csrfToken };
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { user: SessionUser; csrfToken: string };
  return { user: body.user, csrfToken: body.csrfToken };
}

export async function logout(csrfToken: string): Promise<void> {
  const res = await request('/api/v1/auth/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
  });
  if (!res.ok) throw await toError(res);
}

/** A sentence a person can act on, for an error from the API. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Wrong email or password.';
      case 'rate_limited':
        return 'Too many sign-in attempts. Wait a few minutes and try again.';
      case 'invalid_request':
        return 'Enter your email and password.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Could not reach the server. Check your connection and try again.';
}
