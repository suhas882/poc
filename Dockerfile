# Public Records AI Search: one container image for any host (Azure VM today, AWS EC2/ECS or others later).
# State lives only in /data (SQLite database, uploaded originals, sync state); mount it on a persistent local disk.

# ---- build: compile the browser TypeScript ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8765 \
    DATA_DIR=/data \
    OCR_LANG_PATH=/app
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only (pdfjs, the OCR engine and the optional PostgreSQL/MySQL drivers); test tools are left out.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app ./
RUN rm -rf node_modules/.cache tests && mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8765
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
