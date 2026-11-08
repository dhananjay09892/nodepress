import { serve } from '@hono/node-server';
import { createNodePress } from '@nodepress/core';
import { createDatabase } from '@nodepress/db';
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

const server = serve({ fetch: createApp(np, database).fetch, port }, (info) => {
  np.logger.info(`Listening on http://localhost:${info.port}`);
});

async function stop(signal: string) {
  np.logger.info(`Received ${signal}, shutting down…`);
  server.close();
  await np.shutdown();
  await database.close();
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
