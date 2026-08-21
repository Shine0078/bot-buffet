FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 BOT_BUFFET_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui ./ui
RUN addgroup -S buffet && adduser -S buffet -G buffet && mkdir -p /data && chown -R buffet:buffet /app /data
USER buffet
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
