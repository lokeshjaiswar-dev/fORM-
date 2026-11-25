# syntax=docker/dockerfile:1
# fORM- builder (Forms+): static SPA served by nginx-unprivileged on :8080 under /formplus/.
# Build from the repository root:
#   docker build -f apps/builder/Dockerfile \
#     --build-arg VITE_FP_DMS_API_BASE=https://dms.example/api \
#     --build-arg VITE_FP_DMS_API_ORIGINS=https://dms.example \
#     --build-arg VITE_FP_EMBED_PARENTS=https://dms.example \
#     --build-arg VITE_FP_RETURN_ORIGINS=https://dms.example \
#     -t form-builder .
# Every VITE_* value is baked into the bundle and into the CSP headers at build time (docs/platform/builder-security-headers.md).
# No secret belongs in a build arg.

FROM node:24-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @form/builder...

ARG VITE_BASE=/formplus/
ARG VITE_API_URL=
ARG VITE_FP_DMS_API_BASE=
ARG VITE_FP_DMS_API_ORIGINS=
ARG VITE_FP_EMBED_PARENTS=
ARG VITE_FP_RETURN_ORIGINS=
ARG VITE_WEBHOOK_DOCS_URL=
ENV VITE_BASE=$VITE_BASE \
    VITE_API_URL=$VITE_API_URL \
    VITE_FP_DMS_API_BASE=$VITE_FP_DMS_API_BASE \
    VITE_FP_DMS_API_ORIGINS=$VITE_FP_DMS_API_ORIGINS \
    VITE_FP_EMBED_PARENTS=$VITE_FP_EMBED_PARENTS \
    VITE_FP_RETURN_ORIGINS=$VITE_FP_RETURN_ORIGINS \
    VITE_WEBHOOK_DOCS_URL=$VITE_WEBHOOK_DOCS_URL
# The signed system template pack (packages/templates/dist, git- and docker-ignored) is built first:
# the builder imports @form/templates/packs/system-core-*.formpack.
RUN pnpm --filter @form/templates build \
 && pnpm --filter @form/builder build \
 && node apps/builder/security/render-nginx.ts /out/fp

FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV FP_WEB_ROOT=/usr/share/nginx/html \
    FP_HEADERS_DIR=/etc/nginx/fp
COPY --from=build /repo/apps/builder/dist /usr/share/nginx/html/formplus
COPY --from=build /out/fp /etc/nginx/fp
COPY apps/builder/deploy/moved.html /usr/share/nginx/html/moved/formbuilder.html
COPY apps/builder/deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/formplus/healthz || exit 1
