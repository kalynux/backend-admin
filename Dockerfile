# syntax=docker/dockerfile:1
#
# wi-admin — three targets: builder · toolbox · runtime.
#
# Same shape and same base as `jovi-mall/Dockerfile`; read that file's header for the
# reasoning behind the toolbox split (D-5), the Debian base (D-4) and the three places
# Node 22 is pinned (ADR-019 D-1). Only what differs for this service is written here.
#
# ═══ WHAT DIFFERS ════════════════════════════════════════════════════════════════
#
#  1. This service has ONE operational script rather than fifteen — `ensure:indexes`,
#     plus `bootstrap:admin` and `audit:export`. The toolbox stage is built anyway,
#     because plan step 2.C.1 ledgers `ensure:indexes` alongside jovi-mall's
#     migrations, and because an index build is a deployment step by its own header's
#     argument. One image per service beats one special case.
#
#  2. `src/` holds NO non-TypeScript assets and reads nothing off disk by
#     `__dirname` — verified, not assumed. So `tsc` alone produces a complete `dist/`
#     and there is no asset-copy step of the kind jovi-mall needs for its Handlebars
#     mail templates.
#
#  3. The writable path is `var/audit-exports`, not `storage/` — see the volume note
#     on the runtime stage.
#
#  4. The probes are `/health/live` and `/health/ready`, UNVERSIONED. There is no
#     wi-admin equivalent of jovi-mall's frozen `GET /api/health`.

# ═════════════════════════════════════════════════════════════════════════════════
#  builder
# ═════════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# NODE_ENV is deliberately NOT production here: npm 8+ reads it and would omit the
# devDependencies this stage exists to use.

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

# ═════════════════════════════════════════════════════════════════════════════════
#  toolbox — index builds, the admin bootstrap, audit exports
# ═════════════════════════════════════════════════════════════════════════════════
FROM builder AS toolbox

# Root, on purpose: a `run --rm` maintenance container that holds no port and lives
# for one command. `audit:export` also writes NDJSON into the mounted volume.

# No ENTRYPOINT — `docker compose run --rm admin-toolbox npm run ensure:indexes`
# overrides CMD but not an entrypoint, and `ENTRYPOINT ["npm","run"]` would expand
# that to `npm run npm run ensure:indexes`.
CMD ["npm", "run", "ensure:indexes"]

# ═════════════════════════════════════════════════════════════════════════════════
#  runtime — LAST stage, so it is the default build target
# ═════════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Mountpoint for the audit-export volume (D-7). `ADMIN_AUDIT_EXPORT_DIR` defaults to
# `./var/audit-exports`, resolved against the process CWD — so it is /app/var/audit-exports
# only because WORKDIR is the application root. `audit-export.service.ts` mkdir -p's it,
# but it must be owned by `node` before the drop below or the first export fails.
RUN mkdir -p /app/var/audit-exports && chown -R node:node /app/var

USER node

EXPOSE 8033

# Liveness only. `/health/live` touches no dependency, which is the point: an
# orchestrator RESTARTS on a failing liveness probe, and restarting this service does
# not fix somebody else's database — a dependency outage must not become a restart
# loop. Readiness is `/health/ready` and belongs in the orchestrator's config, not
# here. `curl` and `wget` are both absent from bookworm-slim, so the probe uses node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8033,path:'/health/live'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# EXEC form. Shell form puts `/bin/sh` at PID 1, where it neither forwards SIGTERM nor
# exits on it, and `lifecycle.ts`'s drain never runs — wi-admin's audit subsystem is
# fail-closed, so a severed write is exactly the case its design is built around.
CMD ["node", "dist/server.js"]
