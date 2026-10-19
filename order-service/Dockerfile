# syntax=docker/dockerfile:1

# Three stages, two of them throwaway. The split exists so the runtime image
# carries neither the TypeScript toolchain nor a dev dependency: `npm ci` runs
# twice (once with dev deps to build, once without to ship) rather than once
# followed by `npm prune`, which would leave what it removed behind in the
# layer anyway.

# ---------------------------------------------------------------------------
# Stage 1 — production dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS prod-deps

WORKDIR /app

COPY package*.json ./

# No apk build toolchain here on purpose: every production dependency is
# either pure JS or ships a musl prebuild. Adding a native dependency that
# compiles (bcrypt was one, and unused) means python3/make/g++ in this stage
# and in the builder.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2 — build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

# Only what `tsc` reads. Copying the whole context would invalidate this layer
# on every doc or compose edit (see .dockerignore for the rest).
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# Migrations are read from the compiled output here: there is no src/ in this
# image and no tsx to run .ts files. The defaults in lib/config/env.ts
# (src/migrations, ts) are the right ones for a developer machine and the wrong
# ones for a container, and the path is resolved relative to /app.
# An `env_file`/`environment` entry in compose still wins over these, so the
# compose files repeat them — a .env holding the dev defaults would otherwise
# put them back.
ENV DB_MIGRATION_DIRECTORY=dist/migrations \
    DB_MIGRATION_EXTENSION=js

WORKDIR /app

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# The node image ships an unprivileged `node` user. Nothing the service does
# writes to the filesystem, so root-owned files it can only read are correct.
USER node

EXPOSE 3001

# Reaches the same endpoint a load balancer would. /api/health answers 503 when
# a shard is unreachable, so an unhealthy container means the service cannot
# serve, not merely that the process is alive. The worker runs from this same
# image and serves no HTTP — compose disables the check for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
