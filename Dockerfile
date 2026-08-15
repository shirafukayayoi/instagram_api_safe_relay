FROM node:24-bookworm AS builder

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.json biome.json ./
COPY packages ./packages
COPY examples ./examples
RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim AS relay-slim

WORKDIR /app
ENV NODE_ENV=production
ENV INSTAGRAM_RELAY_SETTINGS=/app/settings.json
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

WORKDIR /app/packages/server
HEALTHCHECK CMD curl -fsS http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]

