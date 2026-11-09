import { serve } from '@hono/node-server';
import {
  createApiTokensService,
  createArgon2Hasher,
  createCapabilities,
  createContentService,
  createContentTypeRegistry,
  createLocalStorage,
  createMediaService,
  createJobQueue,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createScheduledPublisher,
  createSharpProcessor,
  createSessionsService,
  createUsersService,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentStore,
  createDatabase,
  createJobsStore,
  createMediaStore,
  createOptionsStore,
  createSessionsStore,
  createSlugRedirectsStore,
  createUsersStore,
} from '@nodepress/db';
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

// The job queue must exist before plugins activate so they can register jobs in setup().
const jobs = createJobQueue({
  store: createJobsStore(database),
  hooks: np.hooks,
  logger: np.logger.child('jobs'),
});
np.plugins.useJobs(jobs);

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

const apiTokens = createApiTokensService({
  store: createApiTokensStore(database),
  users,
  hooks: np.hooks,
});

const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
const contentStore = createContentStore(database);
const permalinks = createPermalinkService({
  store: contentStore,
  redirects: createSlugRedirectsStore(database),
  options,
  hooks: np.hooks,
  logger: np.logger,
});
// Remembers old slugs whenever content is saved with a new one through the content API.
permalinks.attach();

// Scheduled posts publish themselves when their time comes.
const content = createContentService({
  store: contentStore,
  hooks: np.hooks,
  logger: np.logger.child('content'),
});
// Plugins add content types through a filter; pick them up now that they are activated.
const contentTypes = createContentTypeRegistry({
  hooks: np.hooks,
  logger: np.logger.child('content-types'),
});
await contentTypes.refresh();
const scheduledPublisher = createScheduledPublisher({
  content,
  jobs,
  hooks: np.hooks,
  logger: np.logger.child('scheduled-publishing'),
});
scheduledPublisher.attach();
// Catch scheduled posts that came due while the site was down, then start the runner.
await scheduledPublisher.sweep().catch((error) => np.logger.warn(String(error)));
jobs.start();
const jobPurgeTimer = setInterval(
  () => void jobs.purgeDone().catch((error) => np.logger.warn(String(error))),
  60 * 60 * 1000,
);
jobPurgeTimer.unref();

// Expired sessions are rejected on use; this just keeps the table small.
const purgeTimer = setInterval(
  () => void sessions.purgeExpired().catch((error) => np.logger.warn(String(error))),
  60 * 60 * 1000,
);
purgeTimer.unref();

// Uploaded files live on local disk; MEDIA_DIR moves them (mount a volume there in Docker).
const mediaStorage = createLocalStorage(process.env.MEDIA_DIR ?? './media');
const media = createMediaService({
  store: createMediaStore(database),
  storage: mediaStorage,
  processor: createSharpProcessor(),
  hooks: np.hooks,
  logger: np.logger.child('media'),
  ...(process.env.MAX_UPLOAD_BYTES ? { maxBytes: Number(process.env.MAX_UPLOAD_BYTES) } : {}),
});

const capabilities = createCapabilities(np.hooks);
const app = createApp(np, database, {
  permalinks,
  content: { service: content, types: contentTypes, capabilities },
  media: { service: media, storage: mediaStorage, capabilities },
  auth: {
    users,
    sessions,
    apiTokens,
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
  clearInterval(jobPurgeTimer);
  await jobs.stop();
  server.close();
  await np.shutdown();
  await database.close();
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
