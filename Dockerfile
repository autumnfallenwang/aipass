# syntax=docker/dockerfile:1.7
# aipass images (S7). One Dockerfile, three targets:
#   docker build --target api     -t aipass-api .
#   docker build --target gateway -t aipass-gateway .
#   docker build --target web     -t aipass-web .
# `docker compose up` (compose.yaml) builds and runs all three.

ARG NODE_IMAGE=node:24.21.0-alpine

# ---------- build: install once, bundle the servers, build the web app ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm bundle
# The web app passes /api/* to the api; in the container network that's `api`.
ARG API_URL=http://api:3001
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1 API_URL=${API_URL}
RUN pnpm --filter @aipass/web exec next build

# ---------- runtime base: just Node, as the unprivileged `node` user ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/autumnfallenwang/aipass"
LABEL org.opencontainers.image.description="aipass: a pass for AI in healthcare"

# ---------- api: logins, admin API, pass signing (+ the one-shot `init`) ----------
FROM runtime AS api
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/packages/db/drizzle ./drizzle
COPY --from=build /src/fixtures ./fixtures
ENV AIPASS_MIGRATIONS_DIR=/app/drizzle AIPASS_FIXTURES_DIR=/app/fixtures API_PORT=3001
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

# ---------- gateway: the door AI clients use ----------
FROM runtime AS gateway
COPY --from=build /src/apps/gateway/dist ./dist
ENV GATEWAY_PORT=3002
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3002/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

# ---------- web: the admin UI and the person's pages (Next standalone) ----------
FROM runtime AS web
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
ENV PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
