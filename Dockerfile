FROM node:22-alpine

ENV NODE_ENV=production \
    FELTUS_ENV=production \
    FELTUS_HOST=0.0.0.0 \
    FELTUS_PORT=8080 \
    FELTUS_STORAGE_ROOT=/data/feltus-storage

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node index.html ./index.html
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/bootstrap-owner.mjs ./scripts/bootstrap-owner.mjs

RUN mkdir -p /data/feltus-storage && chown -R node:node /data/feltus-storage /app

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
