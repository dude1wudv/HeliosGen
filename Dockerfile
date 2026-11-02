FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_APP_BASE_PATH=/cancas
ENV NEXT_PUBLIC_APP_BASE_PATH=${NEXT_PUBLIC_APP_BASE_PATH}
ENV NEXT_TELEMETRY_DISABLED=1 SUB2API_MANAGED_MODE=true NEXT_PUBLIC_SUB2API_MANAGED_MODE=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ARG NEXT_PUBLIC_APP_BASE_PATH=/cancas
ENV NEXT_PUBLIC_APP_BASE_PATH=${NEXT_PUBLIC_APP_BASE_PATH}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 HELIOS_DATA_DIR=/data
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 helios \
  && useradd --system --uid 1001 --gid helios helios \
  && mkdir -p /app /data \
  && chown -R helios:helios /app /data
WORKDIR /app
COPY --from=build --chown=helios:helios /app/.next/standalone ./
COPY --from=build --chown=helios:helios /app/.next/static ./.next/static
COPY --from=build --chown=helios:helios /app/public ./public
USER helios
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000'+(process.env.NEXT_PUBLIC_APP_BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
