# DO NOT EDIT — locked file from the nuxt-base kit (presets/deploy/container). `scaffold update` overwrites it.
# Node API, multi-stage: build (dist/) -> production deps -> runtime without npm.
# Needs package-lock.json and a "build" script that writes dist/index.js.
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The build time travels with the compiled code: GET /version reports it when no APP_BUILT_AT build arg is given.
RUN npm run build && date -u +%Y-%m-%dT%H:%M:%SZ > dist/build-time.txt

# Production deps in their own stage, so the runtime image needs no npm.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE}
# Latest OS patches (a cached base is usually stale) and no npm/corepack: the runtime only needs node, and the bundled
# npm is where most image CVEs come from. Never call npm/npx in CMD, HEALTHCHECK or scripts run inside the container.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# What GET /version reports. Optional — a deploy script that passes neither still gets a commit (from the image tag,
# APP_IMAGE_TAG in the compose file) and a build time (dist/build-time.txt above). Exact values:
#   docker build --build-arg APP_COMMIT=$(git rev-parse HEAD) --build-arg APP_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) …
# Declared last, so passing them never invalidates the layers above.
ARG APP_COMMIT=
ARG APP_BUILT_AT=
ENV APP_COMMIT=${APP_COMMIT} APP_BUILT_AT=${APP_BUILT_AT}
# Not root: files the app writes land in the bind mount with a normal owner, and the home dir is /home/node.
USER node
EXPOSE 3000
# 127.0.0.1, not localhost: alpine resolves localhost to ::1 while the server listens on IPv4.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
