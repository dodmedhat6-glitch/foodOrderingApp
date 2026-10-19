# syntax=docker/dockerfile:1

# core-service image. Four targets are built from this one file:
#   builder  - compiles TypeScript to dist/ (intermediate)
#   migrator - runs `npm run migrate`; keeps src/ because the migrations are
#              .ts files executed through tsx (DB_MIGRATIONS_EXTENSION=ts)
#   test     - runs the Jest integration suite against throwaway infra
#   runner   - the default, production target: dist/ + prod deps only
#
# bcrypt is a native addon with no musl prebuild, so every stage that installs
# dependencies needs a compiler. The toolchain stays out of `runner`, which
# copies an already-built node_modules from `prod-deps`.

ARG NODE_VERSION=22-alpine


# ---- full dependencies (incl. dev) ------------------------------------------
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

RUN npm ci


# ---- production dependencies only -------------------------------------------
FROM node:${NODE_VERSION} AS prod-deps

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

RUN npm ci --omit=dev


# ---- compile ----------------------------------------------------------------
FROM deps AS builder

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# ---- migrations -------------------------------------------------------------
# env.ts resolves DB_MIGRATIONS_DIRECTORY relative to three levels above
# src/lib/config, i.e. /app/src/migrations here - so the layout must match the
# repository's, not dist/'s.
FROM deps AS migrator

ENV NODE_ENV=production

COPY tsconfig.json knexfile.ts ./
COPY src ./src

CMD ["npm", "run", "migrate"]


# ---- integration tests ------------------------------------------------------
FROM deps AS test

ENV NODE_ENV=test

COPY tsconfig.json tsconfig.test.json knexfile.ts ./
COPY jest.config.js jest.integration.config.js jest.resolver.js jest.setup.ts ./
COPY src ./src
COPY tests ./tests

CMD ["npm", "run", "test:integration"]


# ---- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
