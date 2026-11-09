import { serve } from '@hono/node-server';
import {
  createArgon2Hasher,
  createNodePress,
  createSessionsService,
  createUsersService,
} from '@nodepress/core';
import { createDatabase, createSessionsStore, createUsersStore } from '@nodepress/db';
import helloPlugin from '@nodepress/plugin-hello';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);

// DATABASE_URL picks the dialect: file:… / libsql://… (SQLite) or postgres://… (PostgreSQL).
const database = createDatabase({
  url: process.env.DATABASE_URL ?? 'file:./nodepress.db',
  ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
});

const np = createNodePress({
  config: { siteName: process.env.SITE_NAME ?? 'My NodePress Site' },
  plugins: [helloPlugin],
});

try {
  await database.migrate();
} catch (error) {
  np.logger.warn(error instanceof Error ? error.message : String(error));
}

await np.boot();

const users = createUsersService({
  store: createUsersStore(database),
  hooks: np.hooks,
  hasher: createArgon2Hasher(),
});
const sessions = createSessionsService({
  store: createSessionsStore(database),
  users,
  hooks: np.hooks,
});

// Expired sessions are rejected on use; this just keeps the table small.
const purgeTimer = setInterval(
  () => void sessions.purgeExpired().catch((error) => np.logger.warn(String(error))),
  60 * 60 * 1000,
);
purgeTimer.unref();

const app = createApp(np, database, {
  auth: {
    users,
    sessions,
    // Cookies are Secure by default; set COOKIE_SECURE=false only for plain-HTTP local development.
    secureCookies: process.env.COOKIE_SECURE !== 'false',
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  np.logger.info(`Listening on http://localhost:${info.port}`);
});

async function stop(signal: string) {
  np.logger.info(`Received ${signal}, shutting down…`);
  clearInterval(purgeTimer);
  server.close();
  await np.shutdown();
  await database.close();
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
