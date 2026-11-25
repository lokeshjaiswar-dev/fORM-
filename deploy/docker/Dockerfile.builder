FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY dmacq-ui-0.1.0.tgz ./
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @form/builder build

FROM nginx:1.27-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/builder/dist /usr/share/nginx/html
EXPOSE 80
