# Multi-stage self-hosted image: Node 24 game server + SvelteKit adapter-node client on one port.
# Base node:24-trixie-slim ships glibc 2.41 so native WebTransport addons can be added later.

FROM node:24-trixie-slim AS build
RUN corepack enable
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web

RUN pnpm --filter web exec svelte-kit sync \
 && SURF_ADAPTER=node pnpm --filter web build \
 && pnpm --filter server build \
 && pnpm --filter server deploy --prod --ignore-scripts /out/server \
 && npm_config_nodedir=/usr/local pnpm --dir /out/server rebuild better-sqlite3 \
 && pnpm --filter web deploy --prod --ignore-scripts /out/web

FROM node:24-trixie-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/surf.db \
    BACKUP_DIR=/data/backups \
    WEB_HANDLER=/app/web/handler.js

WORKDIR /app

COPY --from=build /out/server/package.json ./package.json
COPY --from=build /out/server/node_modules ./node_modules
COPY --from=build /src/apps/server/dist/server.mjs ./dist/server.mjs
COPY --from=build /src/apps/web/build ./web
COPY --from=build /out/web/package.json ./web/package.json
COPY --from=build /out/web/node_modules ./web/node_modules

RUN mkdir -p /data/backups && chown -R node:node /data

USER node
RUN node -e 'const db = new (require("better-sqlite3"))(":memory:"); db.close()'
EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "dist/server.mjs"]
