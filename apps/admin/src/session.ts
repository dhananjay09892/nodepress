import { queryOptions } from '@tanstack/react-query';
import { fetchSession } from './api.js';

/** The signed-in session (or `null`). Kept in the query cache; login and logout update it. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: fetchSession,
  staleTime: Infinity,
});
