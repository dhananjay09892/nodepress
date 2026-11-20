# syntax=docker/dockerfile:1
# NodePress image: builds the monorepo (server, admin, themes, plugins) and runs the server.
# Data (database, uploads, installed plugins) lives in /data: mount a volume there.

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
# The documentation site is not part of the image.
RUN pnpm install --no-frozen-lockfile --filter '!@nodepress/docs'
# The database migrations are committed; generate them only if a checkout lacks them.
RUN if [ ! -d packages/db/drizzle/sqlite ] || [ ! -d packages/db/drizzle/postgres ]; then \
      pnpm --filter @nodepress/db db:generate; \
    fi
RUN pnpm turbo run build --filter='!@nodepress/docs'

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/data/nodepress.db \
    MEDIA_DIR=/data/media \
    PLUGINS_DIR=/data/plugins
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/media /data/plugins && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
