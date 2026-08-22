# Base images are pinned by digest so a rebuild produces the same runtime, and
# so a compromised or simply changed upstream tag cannot alter what ships
# without a visible commit. The tag is kept in the comment for readability.
# Re-pin deliberately: docker buildx imagetools inspect node:22-alpine
# node:22-alpine
FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
# tsconfig.build.json extends tsconfig.json and is the config the build
# actually uses, so both must be present. Copying only tsconfig.json made
# `npm run build` fail inside the image while succeeding on the host.
COPY package*.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
RUN npm run build

# node:22-alpine
FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
# BOT_BUFFET_HOST is 0.0.0.0 here and loopback everywhere else: binding
# loopback inside a container makes the published port unreachable, while
# defaulting to loopback on a workstation keeps a credential-holding control
# plane off the network unless someone deliberately exposes it.
ENV NODE_ENV=production PORT=8787 BOT_BUFFET_HOST=0.0.0.0 BOT_BUFFET_DATA_DIR=/data
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
