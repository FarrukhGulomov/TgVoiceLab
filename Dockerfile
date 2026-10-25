# syntax=docker/dockerfile:1.7
# Production image for the assistant. It EXCLUDES the Phase 0 spike (experiments/). It DOES contain the LGPL-3.0 `ntgcalls` native addon
# (a production dependency of apps/assistant, loaded only when CALL_ADAPTER=ntgcalls), about 98 MB: redistributing this image carries the
# LGPL obligations listed in docs/THIRD_PARTY_NOTICES.md. Calling stays disabled by default (CALLS_ENABLED=false, CALL_ADAPTER=disabled).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/assistant/package.json apps/assistant/
COPY experiments/telegram-calls/package.json experiments/telegram-calls/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @tgvl/assistant... --filter @tgvl/contracts...
COPY packages packages
COPY apps apps
COPY scripts scripts
RUN pnpm --filter @tgvl/contracts run build && pnpm --filter @tgvl/assistant run build
RUN pnpm --filter @tgvl/assistant deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ARG BUILD_FINGERPRINT=unset
ENV NODE_ENV=production BUILD_FINGERPRINT=${BUILD_FINGERPRINT} HTTP_HOST=0.0.0.0
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /out /app
COPY --chown=app:app db /app/db
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
