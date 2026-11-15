# DO NOT EDIT — locked file from the nuxt-base kit (presets/deploy/container). `scaffold update` overwrites it.
# Nuxt, multi-stage: nuxt build -> runtime with only .output (no npm, no node_modules).
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# nuxt build directly: a project's "build" script may chain tests, which do not belong in an image build.
RUN npx nuxt build

FROM ${NODE_IMAGE}
# Latest OS patches and no npm/corepack (see the API Dockerfile).
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/.output ./.output
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1
CMD ["node", ".output/server/index.mjs"]
