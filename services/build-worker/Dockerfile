ARG BUILDKIT_IMAGE=moby/buildkit:v0.20.2-rootless
FROM ${BUILDKIT_IMAGE} AS buildkit
FROM node:22-alpine

RUN apk add --no-cache git
COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src/build-worker.js ./src/build-worker.js
COPY --chown=node:node src/lib/feltus-build-worker.js ./src/lib/feltus-build-worker.js
COPY --chown=node:node src/lib/feltus-github.js ./src/lib/feltus-github.js

ENV NODE_ENV=production
USER node
EXPOSE 8082
CMD ["node", "src/build-worker.js"]