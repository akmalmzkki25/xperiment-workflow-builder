# syntax=docker/dockerfile:1

# Ships TypeScript source and runs it with tsx.
#
# That is a decision, not a shortcut. `tsconfig.base.json` sets `noEmit`, and sixteen of
# eighteen package.json files point `main` at a `.ts` file. Adding a compile step for the
# container would mean rewriting every manifest and creating a second code path that only
# containers take — the classic generator of "works in dev, breaks in prod". `apps/web` is
# the one genuine exception, because Next has a real build and `next start` refuses
# without it.

FROM node:20-alpine AS base
RUN corepack enable
ENV HOME=/home/node PNPM_HOME=/home/node/.pnpm CI=true
WORKDIR /app
# WORKDIR creates /app owned by root. Chowning the copied files is not enough — pnpm
# writes a temp file into the directory itself and fails with EACCES.
RUN chown node:node /app

FROM base AS deps
# Runs unprivileged: a workflow engine that executes author-supplied HTTP calls is not
# something to hand root, even inside a container.
USER node
# The whole context in one layer. Splitting manifests out to cache the install needs
# either `COPY --parents` (labs syntax) or eighteen COPY lines, and neither is worth the
# fragility for an image that is rebuilt rarely. `.dockerignore` keeps the context small.
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile

# The five backend services. Which one runs is chosen by the compose `command`, so all
# five share a single image and a single build.
FROM deps AS backend
CMD ["pnpm", "--filter", "@xperiment/api", "start"]

FROM deps AS web
# Baked in at build time, not read at runtime: Next inlines NEXT_PUBLIC_* into the client
# bundle, so a deployment behind a different hostname needs a rebuild rather than a
# restart. Saying so here is cheaper than debugging it later.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @xperiment/web build
CMD ["pnpm", "--filter", "@xperiment/web", "start"]
